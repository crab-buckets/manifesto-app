import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useMotionValue, useSpring } from 'motion/react';
import { Settings as Cog, Paperclip, FileText } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Counter from './components/Counter/Counter';
import BorderGlow from './components/BorderGlow/BorderGlow';
import Shredder from './components/Shredder/Shredder';
import HoldButton from './components/HoldButton/Holdbutton';
import RevealBox from './components/RevealBox/RevealBox';
import FuseButton from './components/FuseButton/FuseButton';
import GlideSelect from './components/GlideSelect/GlideSelect';
import ErrorBoundary from './components/ErrorBoundary';
import TextType from './components/TextType/TextType';
import mapImg from './assets/skyrimmap.jpg';
import { api, sk, dLabel, stamp, dayKey, hue, h12, nowInput, inputToIso } from './api';
import { THEMES, FONTS } from './themes';

// A few Discord-style extras marked doesn't support out of the box: ||spoilers||, __underline__
// (GFM treats __x__ as bold; Discord uses it for underline instead, so this intercepts it first),
// and >>> which — in Discord — turns the rest of the message into one blockquote.
marked.use({
  extensions: [
    {
      name: 'spoiler', level: 'inline',
      start(src) { const i = src.indexOf('||'); return i < 0 ? undefined : i; },
      tokenizer(src) { const m = /^\|\|([\s\S]+?)\|\|/.exec(src); if (m) return { type: 'spoiler', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }; },
      renderer(token) { return `<span class="spoiler">${this.parser.parseInline(token.tokens)}</span>`; },
    },
    {
      name: 'underline', level: 'inline',
      start(src) { const i = src.indexOf('__'); return i < 0 ? undefined : i; },
      tokenizer(src) { const m = /^__([^\n]+?)__(?!_)/.exec(src); if (m) return { type: 'underline', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }; },
      renderer(token) { return `<u>${this.parser.parseInline(token.tokens)}</u>`; },
    },
    {
      name: 'quoteRest', level: 'block',
      start(src) { return /^>>> /.test(src) ? 0 : undefined; },
      tokenizer(src) { const m = /^>>> ([\s\S]*)$/.exec(src); if (m) return { type: 'quoteRest', raw: m[0], tokens: this.lexer.blockTokens(m[1], []) }; },
      renderer(token) { return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>`; },
    },
  ],
  renderer: {
    // A link in a case file leads off-site — open it in a new tab rather than navigating away
    // from the archive, and never hand the target page a reference back to us.
    // marked@12's Renderer.link is called with classic positional args (href, title, text) —
    // not a token object — so this must not destructure or reach for this.parser here.
    link(href, title, text) {
      return `<a href="${href}" title="${title || ''}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});
const md = (s) => ({ __html: DOMPurify.sanitize(marked.parse(s || '')) });
const spoil = (e) => e.target.classList.contains('spoiler') && e.target.classList.toggle('revealed'); // click a spoiler span to reveal it
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const excerpt = (b) => b.replace(/[#>*_`[\]|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 320);
const glow = { backgroundColor: 'var(--panel)', glowColor: '40 50 60', colors: ['#b6913e', '#a83a32', '#4c8d82'], borderRadius: 10 };
// Reads a CSS custom property off the document root, live — used to hand the canvas-based
// Shredder actual colour values (it can't resolve var(--x) itself), and re-reads whenever the
// theme changes so it follows along instead of staying stuck on whatever loaded first.
function useThemeVar(name, fallback) {
  const read = () => (typeof document === 'undefined' ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
  const [v, setV] = useState(read);
  useEffect(() => {
    setV(read());
    const obs = new MutationObserver(() => setV(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, [name]);
  return v;
}

// Thin theming wrapper around GlideSelect so every dropdown in the app shares one look instead of
// each call site repeating the same five color props. `options` takes GlideSelect's own shape
// (a string, or {value, label, tag}); `onChange` gets just the picked value, like a plain setter.
function Sel({ options, value, onChange, ariaLabel, placeholder, size = 'md' }) {
  return (
    <GlideSelect options={options} value={value} onChange={(v) => onChange(v)} ariaLabel={ariaLabel} placeholder={placeholder}
      showTags={false} size={size} accentColor="var(--wax)" surfaceColor="var(--cell)" highlightColor="var(--line)" textColor="var(--ink)" />
  );
}

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

const MAX_CLEARANCE = 5;
const CLEARANCE_LABEL = ['Everyone', 'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Warden only'];
const ClearanceSelect = ({ value, onChange }) => (
  <Sel ariaLabel="Clearance level" options={CLEARANCE_LABEL.map((l, i) => ({ value: i, label: `Clearance: ${l}` }))} value={value} onChange={onChange} />
);

const CONF = { rumour: 'Rumour', witnessed: 'Witnessed', confirmed: 'Confirmed' };
const Meta = ({ conf, source }) => <>{conf && <span className={'conf ' + conf}>{CONF[conf]}</span>}{source && <span className="src">Source: {source}</span>}</>;
const ConfSelect = ({ value, onChange }) => (
  <Sel ariaLabel="Confidence" options={[{ value: '', label: 'Confidence: unrated' }, ...Object.entries(CONF).map(([k, l]) => ({ value: k, label: l }))]}
    value={value || ''} onChange={onChange} />
);
// A GlideSelect dropdown for picking an existing value, with a "+ Add new…" option that swaps in a
// plain text field for typing one that isn't on the list yet (a source, a tag category) — the same
// pick-or-type freedom the old <input list> datalist gave, just via the app's own dropdown widget.
const NEW_OPT = '__new__';
function PickOrType({ options, value, onChange, ariaLabel, placeholder, addLabel = '+ Add new…' }) {
  const [typing, setTyping] = useState(false);
  const known = options.includes(value);
  const showInput = typing || (!!value && !known);
  if (showInput) {
    return (
      <span className="pick-or-type">
        <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={typing} />
        {options.length > 0 && <button type="button" className="linklike" onClick={() => { setTyping(false); onChange(''); }}>choose existing</button>}
      </span>
    );
  }
  return (
    <Sel ariaLabel={ariaLabel} placeholder={placeholder} options={[...options.map((o) => ({ value: o, label: o })), { value: NEW_OPT, label: addLabel }]}
      value={value || ''} onChange={(v) => (v === NEW_OPT ? (setTyping(true), onChange('')) : onChange(v))} />
  );
}
function SourceField({ value, onChange }) { // pick an existing source, or add a new one — new ones join the list permanently
  const [list, setList] = useState([]);
  useEffect(() => { api.get('/sources').then(setList).catch(() => {}); }, []);
  return <PickOrType options={list} value={value || ''} onChange={onChange} ariaLabel="Source" placeholder="Source" addLabel="+ New source…" />;
}

function Overlay({ id, close, children }) { // frosted backdrop; the card grows into the sheet (shared layoutId)
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && close();
    addEventListener('keydown', k); document.body.style.overflow = 'hidden';
    return () => { removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, []);
  return createPortal(
    <div className="overlay-wrap">
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: .3, ease: [0.22, 1, 0.36, 1] }} onClick={close} />
      <motion.div layoutId={id} className="sheet" transition={{ type: 'spring', damping: 32, stiffness: 260, mass: .9 }}>
        <button className="sheet-x" onClick={close}>Close</button>{children}
      </motion.div>
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

const SHEET_SPRING = { type: 'spring', damping: 32, stiffness: 260, mass: .9 };

// Drag-to-shred, shared by the list-row Report card and the Dossier tile. Distinguishes a tap
// (open the record) from a drag (pick the card up and, if released over the shredder, feed it
// straight into the tear/fall animation) using a small movement threshold on pointer events —
// the same pattern the Shredder itself uses internally for its own list. `shredder` is
// `{ isOver(x,y), drop(el,item,x,y) }` from the archive, or null/undefined to disable dragging
// entirely (e.g. on the dashboard, or a report the person can't redact).
function useCardDrag(shredder, item) {
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [hot, setHot] = useState(false);
  const dx = useMotionValue(0), dy = useMotionValue(0), sx = useMotionValue(1);
  const sdx = useSpring(dx, { damping: 28, stiffness: 380, mass: .7 });
  const sdy = useSpring(dy, { damping: 28, stiffness: 380, mass: .7 });
  const ssx = useSpring(sx, { damping: 22, stiffness: 220, mass: .8 });
  const reset = () => { setDragging(false); setHot(false); dx.set(0); dy.set(0); sx.set(1); drag.current = null; };
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, w: e.currentTarget.getBoundingClientRect().width };
    if (shredder) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch {} }
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !shredder) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) { d.moved = true; setDragging(true); }
    if (d.moved) {
      e.preventDefault?.();
      dx.set(e.clientX - d.x); dy.set(e.clientY - d.y);
      const over = shredder.isOver(e.clientX, e.clientY);
      setHot(over);
      // Narrows the card toward the shredder's own width as it's dragged over the slot, so it
      // visibly feeds in rather than a full-size card just sitting on top of the narrow shredder.
      const sw = shredder.width?.();
      sx.set(over && sw && d.w ? Math.max(0.3, Math.min(1, sw / d.w)) : 1);
    }
  };
  const onPointerUp = (e, el, onOpen) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (d.moved) {
      const over = shredder?.isOver(e.clientX, e.clientY);
      reset();
      if (over) shredder.drop(el, item, e.clientX, e.clientY);
    } else { drag.current = null; onOpen(); }
  };
  const onPointerCancel = (e) => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {} reset(); };
  return { dx: sdx, dy: sdy, sx: ssx, dragging, hot, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

// A tilting "dossier" tile — a manila-folder take on the card, reacting to the cursor. Adapted
// from reactbits.dev's Tilted Card pattern (mouse-position -> spring-smoothed rotateX/rotateY)
// using the motion values already in this project rather than pulling in a separate component.
// Generic over what it's a tile for (a report or a person of interest) so both archives share it.
function Dossier({ id, prefix, tag, title, meta, excerpt: ex, redacted, onOpen, shredder, dragItem }) {
  const ref = useRef(null);
  const rx = useMotionValue(0), ry = useMotionValue(0), sc = useMotionValue(1);
  const srx = useSpring(rx, { damping: 26, stiffness: 260, mass: 1 });
  const sry = useSpring(ry, { damping: 26, stiffness: 260, mass: 1 });
  const ssc = useSpring(sc, { damping: 22, stiffness: 260, mass: 1 });
  const cd = useCardDrag(shredder, dragItem);
  const move = (e) => {
    if (cd.dragging) return;
    const rect = ref.current.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5, py = (e.clientY - rect.top) / rect.height - 0.5;
    rx.set(py * -12); ry.set(px * 12);
  };
  const leave = () => { rx.set(0); ry.set(0); sc.set(1); };
  return (
    <motion.article ref={ref} layoutId={prefix + id} transition={SHEET_SPRING}
      className={'dossier' + (redacted ? ' redacted' : '') + (cd.dragging ? ' dragging-out' : '') + (cd.hot ? ' drag-hot' : '')}
      style={{ x: cd.dx, y: cd.dy, scaleX: cd.sx, rotateX: srx, rotateY: sry, scale: ssc, transformPerspective: 900 }}
      onMouseMove={move} onMouseEnter={() => !cd.dragging && sc.set(1.035)} onMouseLeave={leave}
      onPointerDown={cd.onPointerDown} onPointerMove={cd.onPointerMove}
      onPointerUp={(e) => cd.onPointerUp(e, ref.current, onOpen)} onPointerCancel={cd.onPointerCancel}
      role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="dossier-tab">{tag}</div>
      <h3>{title}</h3>
      <p className="meta">{meta}</p>
      <p className="clamp">{ex}</p>
      {redacted && <span className="dossier-stamp">REDACTED</span>}
    </motion.article>
  );
}

function GrantsPanel({ r, onChange }) {
  const [users, setUsers] = useState([]), [granted, setGranted] = useState([]), [pick, setPick] = useState('');
  const load = () => api.get(`/reports/${r.id}/grants`).then(setGranted);
  useEffect(() => { api.get('/users').then(setUsers); load(); }, [r.id]);
  const grant = () => { if (!pick) return; api.post(`/reports/${r.id}/grants`, { userId: +pick }).then(() => { setPick(''); load(); }); };
  const revoke = (uid) => api.del(`/reports/${r.id}/grants/${uid}`).then(load);
  const setClearance = (c) => api.patch(`/reports/${r.id}/clearance`, { clearance: c }).then(onChange);
  const eligible = users.filter((u) => u.role !== 'pending' && u.clearance < r.clearance && !granted.some((g) => g.user_id === u.id));
  return (
    <div className="attach-block">
      <h3>Individual access</h3>
      <p className="dim">An agent's own filing always locks to Warden-only, so agents never see each other's reports. Change it here to open this one up more broadly.</p>
      <ClearanceSelect value={r.clearance} onChange={setClearance} />
      <p className="dim">Everyone below this clearance sees the report scrambled unless granted access here.</p>
      <div>{granted.map((g) => <span key={g.user_id} className="tag-row"><Chip tag={{ name: g.callsign, category: 'Person' }} on />
        <HoldButton size="sm" radius={99} holdTime={800} doneLabel="Gone" backgroundColor="transparent" textColor="var(--dim)"
          fillColor="#a33a34" glow={false} resetAfter={400} className="tag-del" onHold={() => revoke(g.user_id)}>×</HoldButton></span>)}
        {!granted.length && <span className="dim">No individual grants yet.</span>}</div>
      <div className="row">
        <Sel ariaLabel="Grant access to" placeholder="Grant access to..." value={pick} onChange={setPick}
          options={eligible.map((u) => ({ value: u.id, label: u.callsign }))} />
        <button onClick={grant} disabled={!pick}>Grant</button>
      </div>
    </div>
  );
}

export function Report({ r, me, onChange, reveal, variant = 'list', shredder }) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState(null), [f, setF] = useState({}), [err, setErr] = useState('');
  const [allTags, setAllTags] = useState([]), [editPicker, setEditPicker] = useState(false);
  const [seen, setSeen] = useState(false);
  const unread = r.unread && !seen;
  const openReport = () => {
    setOpen(true);
    if (r.unread && !seen) { setSeen(true); api.post(`/reports/${r.id}/read`).catch(() => {}); }
  };
  const late = r.filed_at && Math.abs(new Date(r.filed_at) - new Date(r.created_at)) > 6e4;
  const canRedact = !r.deleted_at && me.role === 'warden'; // only a Warden may redact — an author can no longer pull their own report
  const activeShredder = shredder && canRedact ? shredder : null;
  const cd = useCardDrag(activeShredder, r);
  const hold = r.tags.find((t) => t.category === 'Hold');
  const pick = (m) => {
    setErr(''); setMode(mode === m ? null : m);
    if (m === 'edit') setF({ title: r.title, body: r.body, confidence: r.confidence || '', source: r.source || '', note: '', removeIds: [], addIds: [] });
    if (m === 'addend') setF({ body: '', confidence: '', source: '' });
  };
  const send = (path, body) => api.post(`/reports/${r.id}/${path}`, body).then(() => { setMode(null); onChange(); }).catch((e) => setErr(e.message));
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });
  // Which tags the edit form currently shows as "on": the report's own tags minus any marked for
  // removal, plus anything freshly picked that isn't on the report yet.
  const editTagIds = new Set([...r.tags.map((t) => t.id).filter((id) => !(f.removeIds || []).includes(id)), ...(f.addIds || [])]);
  const editTagObjs = [...r.tags, ...allTags.filter((t) => (f.addIds || []).includes(t.id))].filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);
  const loadTags = () => api.get('/tags').then((c) => setAllTags(c.flatMap((x) => x.tags.map((t) => ({ ...t, category: x.name })))));
  const editToggle = (id) => {
    const onReport = r.tags.some((t) => t.id === id);
    if (onReport) setF((cur) => ({ ...cur, removeIds: (cur.removeIds || []).includes(id) ? cur.removeIds.filter((x) => x !== id) : [...(cur.removeIds || []), id] }));
    else setF((cur) => ({ ...cur, addIds: (cur.addIds || []).includes(id) ? cur.addIds.filter((x) => x !== id) : [...(cur.addIds || []), id] }));
  };
  const card = variant === 'tile' ? (
    <Dossier id={r.id} prefix="r" tag={hold ? hold.name : (r.scrambled ? 'Sealed' : 'Case file')} title={(unread ? '● ' : '') + r.title} meta={r.scrambled ? 'Beyond your clearance' : stamp(r.created_at)}
      excerpt={r.scrambled ? '' : excerpt(r.body)} redacted={!!r.deleted_at || r.scrambled} onOpen={openReport} shredder={activeShredder} dragItem={r} />
  ) : (
    <motion.article layoutId={'r' + r.id} transition={SHEET_SPRING}
      className={'report card' + (r.deleted_at || r.scrambled ? ' redacted' : '') + (cd.dragging ? ' dragging-out' : '') + (cd.hot ? ' drag-hot' : '')}
      style={{ x: cd.dx, y: cd.dy, scaleX: cd.sx }} role="button" tabIndex={0}
      onPointerDown={cd.onPointerDown} onPointerMove={cd.onPointerMove}
      onPointerUp={(e) => cd.onPointerUp(e, e.currentTarget, openReport)} onPointerCancel={cd.onPointerCancel}
      onKeyDown={(e) => e.key === 'Enter' && openReport()}>
      <h3>{unread && <span className="unread-dot" title="Unread" />}{r.title}</h3>
      <p className="meta">{stamp(r.created_at)}{r.scrambled ? '' : `, ${r.author}`} <Meta conf={r.confidence} /></p>
      <p className="clamp">{r.scrambled ? '' : excerpt(r.body)}</p>
      {(r.deleted_at || r.scrambled) && <span className="dossier-stamp">{r.scrambled ? 'SEALED' : 'REDACTED'}</span>}
    </motion.article>
  );
  return (
    <>
      {!open && (reveal ? <RevealBox>{card}</RevealBox> : card)}
      <AnimatePresence>{open && (
        <Overlay id={'r' + r.id} close={() => setOpen(false)}>
          {r.scrambled ? (
            <>
              <h2>{r.title}</h2>
              <p className="meta">{stamp(r.created_at)}</p>
              <div className="md"><p>{r.body}</p></div>
              <p className="dim">You lack the clearance to understand this report. A Warden can raise your standing clearance, or grant you this one specifically.</p>
              {r.tags.length > 0 && <div>{r.tags.map((t) => <Chip key={t.id} tag={t} on />)}</div>}
            </>
          ) : (<>
          <h2>{r.title}</h2>
          <p className="meta">{stamp(r.created_at)}, filed by {r.author}{late && ` on ${stamp(r.filed_at)}`}{r.deleted_at && `. Redacted ${stamp(r.deleted_at)}`} <Meta conf={r.confidence} source={r.source} /></p>
          <div className="md" onClick={spoil} dangerouslySetInnerHTML={md(r.body)} />
          <div>{r.tags.map((t) => <Chip key={t.id} tag={t} on />)}</div>
          {r.addenda.length > 0 && (
            <div className="addenda"><h3>Addenda</h3>
              {r.addenda.map((a) => (
                <div key={a.id} className="addendum">
                  <p className="meta">{stamp(a.created_at)}, {a.author} <Meta conf={a.confidence} source={a.source} /></p>
                  <div className="md" onClick={spoil} dangerouslySetInnerHTML={md(a.body)} />
                </div>))}
            </div>)}
          <Attachments report={r} me={me} onChange={onChange} locked={!!r.deleted_at} />
          {me.role === 'warden' && !r.deleted_at && <GrantsPanel r={r} onChange={onChange} />}
          {r.deleted_at ? (me.role === 'warden' && (
            <div className="row">
              <button onClick={() => api.post(`/reports/${r.id}/restore`).then(onChange)}>Restore</button>
              <HB danger done="Purged" onHold={() => api.del(`/reports/${r.id}/purge`).then(() => { setOpen(false); onChange(); })}>Hold to purge forever</HB>
            </div>
          )) : (
            <div className="row">
              <button onClick={() => pick('edit')}>Edit</button>
              <button onClick={() => pick('addend')}>Add addendum</button>
              {r.revisions.length > 0 && <button onClick={() => pick('hist')}>History ({r.revisions.length})</button>}
              {canRedact && <HB danger done="Redacted" onHold={() => send('redact', {})}>Hold to redact</HB>}
            </div>)}
          </>)}
          {mode === 'edit' && (
            <div className="form"><input value={f.title} onChange={set('title')} /><textarea rows={8} value={f.body} onChange={set('body')} />
              <div className="row"><ConfSelect value={f.confidence} onChange={set('confidence')} /><SourceField value={f.source} onChange={set('source')} /></div>
              <div>{editTagObjs.filter((t) => editTagIds.has(t.id)).map((t) => (
                  <span key={t.id} className="tag-row"><Chip tag={t} on onClick={() => editToggle(t.id)} />
                    <HoldButton size="sm" radius={99} holdTime={600} doneLabel="Off" backgroundColor="transparent" textColor="var(--dim)"
                      fillColor="#a33a34" glow={false} resetAfter={400} className="tag-del" onHold={() => editToggle(t.id)}>×</HoldButton></span>))}
                <button type="button" className="plus" onClick={() => { if (!allTags.length) loadTags(); setEditPicker(true); }} aria-label="Add tags">+ Tags</button></div>
              <p className="dim">A name still mentioned in the text is re-tagged automatically — remove it here only if it shouldn't apply going forward.</p>
              <input placeholder="Why are you changing it? (kept in the history)" value={f.note} onChange={set('note')} />
              <p className="dim">The original and every earlier version stay in the history.</p>
              <button className="primary" onClick={() => send('edit', { ...f, addTagIds: f.addIds, removeTagIds: f.removeIds })}>Save revision</button></div>)}
          {editPicker && <TagPicker tags={allTags} on={editTagIds} toggle={editToggle} close={() => setEditPicker(false)}
            canDelete={me.role === 'warden'} onDeleted={(id) => { setF((cur) => ({ ...cur, addIds: (cur.addIds || []).filter((x) => x !== id) })); loadTags(); }} />}
          {mode === 'addend' && (
            <div className="form"><textarea rows={5} placeholder="Additional information, from this or a later source..." value={f.body} onChange={set('body')} />
              <div className="row"><ConfSelect value={f.confidence} onChange={set('confidence')} /><SourceField value={f.source} onChange={set('source')} /></div>
              <p className="dim">An addendum can't be edited or removed once posted — it's a dated statement on the record.</p>
              <button className="primary" onClick={() => send('addenda', f)}>Post addendum</button></div>)}
          {mode === 'hist' && (
            <div className="form">{r.revisions.map((v) => (
              <details key={v.id}><summary>{stamp(v.edited_at)}, {v.editor}{v.note && `: ${v.note}`}</summary><b>{v.title}</b><div className="md" onClick={spoil} dangerouslySetInnerHTML={md(v.body)} /></details>))}
              <details><summary>Original, {stamp(r.filed_at)}, {r.author}</summary><b>{r.original.title}</b><div className="md" onClick={spoil} dangerouslySetInnerHTML={md(r.original.body)} /></details></div>)}
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
  const load = () => {
    api.get('/stats/heatmap').then(setDays); api.get('/stats/tags').then(setStats); api.get('/reports?limit=6').then(setRecent);
  };
  useEffect(() => { load(); }, []);
  return (
    <>
      <div className="top">
        <section className="panel map-block">
          <h2>The Reach of the {me.brand || 'Manifesto'}</h2>
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
  // Every category that exists, unaffected by the filter above — a search for a tag name shouldn't
  // narrow which categories show up in the "new tag" picker below.
  const allCats = [...new Set(tags.map((t) => t.category))];
  const del = (id) => api.del('/tags/' + id).then(() => onDeleted(id)).catch(() => {});
  return (
    <div className="modal" onClick={close}>
      <div className="panel modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2 style={{ flex: 1 }}>Tags</h2><button className="primary" onClick={close}>Done</button></div>
        <input placeholder="Filter tags..." value={q} onChange={(e) => setQ(e.target.value)} />
        {canDelete && <p className="dim">Hold the × to remove a tag from every report. Posting the same name again re-tags anything that still mentions it.</p>}
        {create && (
          // Kept near the top, above the (often long, scrollable) tag list below: the category
          // dropdown's own menu is positioned relative to this modal and gets clipped by its
          // overflow-y scroll region if opened too close to the bottom edge.
          <div className="row"><PickOrType options={allCats} value={nc} onChange={setNc} ariaLabel="Category" placeholder="Category" addLabel="+ New category…" />
            <input placeholder="New tag" value={nt} onChange={(e) => setNt(e.target.value)} />
            <button onClick={() => create(nc, nt).then(() => setNt(''))}>Create tag</button></div>)}
        {Object.entries(g).map(([c, ts]) => (
          <div key={c}><h3>{c}</h3>{ts.map((t) => (
            <span key={t.id} className="tag-row">
              <Chip tag={t} on={on.has(t.id)} onClick={() => !lock.includes(t.id) && toggle(t.id)} />
              {canDelete && c !== 'Person' && (
                <HoldButton size="sm" radius={99} holdTime={1000} doneLabel="Gone" backgroundColor="transparent" textColor="var(--dim)"
                  fillColor="#a33a34" glow={false} resetAfter={400} className="tag-del" onHold={() => del(t.id)}>×</HoldButton>)}
            </span>))}</div>))}
      </div>
    </div>
  );
}

export function Compose({ done, me }) {
  const [tags, setTags] = useState([]), [title, setTitle] = useState(''), [body, setBody] = useState(''), [when, setWhen] = useState(nowInput());
  const [pick, setPick] = useState([]), [conf, setConf] = useState(''), [source, setSource] = useState(''), [picker, setPicker] = useState(false), [err, setErr] = useState(''), [locked, setLocked] = useState(false);
  const [clearance, setClearance] = useState(0);
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
  const arm = () => { pending.current = { title, body, tagIds: pick, occurredAt: inputToIso(when), confidence: conf, source, clearance }; setLocked(true); setErr(''); };
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
            <div className="row" style={{ marginBottom: 8 }}><ConfSelect value={conf} onChange={setConf} /><SourceField value={source} onChange={setSource} />
              {me.role === 'warden' && <ClearanceSelect value={clearance} onChange={setClearance} />}</div>
            <div>{tags.filter((t) => on.has(t.id)).map((t) => <Chip key={t.id} tag={t} on onClick={() => !auto.includes(t.id) && toggle(t.id)} />)}
              <button type="button" className="plus" onClick={() => setPicker(true)} aria-label="Add tags">+ Tags</button></div>
          </fieldset>
          {err && <p className="bad">{err}</p>}
          <p className="dim">{me.role === 'warden'
            ? (clearance > 0 ? `Below Clearance: ${CLEARANCE_LABEL[clearance]}, this report reads as scrambled nonsense — a Warden can still grant it to specific people.` : 'Everyone can read this one.')
            : 'Filed at Warden-only clearance — only you and a Warden can read it, unless a Warden opens it up further.'}</p>
          <p className="dim">After you press it, the fuse burns for six seconds. Press Undo before it ends and nothing is sent.</p>
          <FuseButton label="Lodge report" doneLabel="Lodged" undoLabel="Undo" undoWindow={6000} size="lg" radius={10} fuse="outline"
            background="#27272a" color="#f5f5f5" fuseColor="#e0b94a" disabled={!title.trim() || !body.trim()} onCommit={arm} onUndo={undo} onFuseEnd={fire} />
        </div>
      </BorderGlow>
      <div className="panel"><h2>{title || 'Preview'}</h2><p className="meta">{dLabel(sk(inputToIso(when)))} <Meta conf={conf} source={source} /></p>
        <div className="md" onClick={spoil} dangerouslySetInnerHTML={md(body || '*Nothing written yet.*')} /></div>
      {picker && <TagPicker tags={tags} on={on} lock={auto} toggle={toggle} create={create} close={() => setPicker(false)}
        canDelete={me.role === 'warden'} onDeleted={(id) => { setPick((p) => p.filter((x) => x !== id)); load(); }} />}
    </div>
  );
}

function ReportsArchive({ me, sel, setSel, view }) {
  const [q, setQ] = useState(''), [rows, setRows] = useState([]), [stats, setStats] = useState([]), [sd, setSd] = useState(false), [k, setK] = useState(0), [picker, setPicker] = useState(false);
  const shredColor = useThemeVar('--cell', '#1b1b1d'), shredSlit = useThemeVar('--line', '#2a2a2c');
  const shredRef = useRef(null);
  useEffect(() => { api.get('/stats/tags').then(setStats); }, [k]);
  useEffect(() => {
    const t = setTimeout(() => api.get(`/reports?q=${encodeURIComponent(q)}&tags=${sel.join(',')}&deleted=${sd ? 1 : 0}`).then(setRows), 250);
    return () => clearTimeout(t);
  }, [q, sel, sd, k]);
  const flip = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const shred = (item) => {
    api.post(`/reports/${item.id}/redact`);
    const now = new Date().toISOString();
    setRows((rs) => (sd ? rs.map((r) => (r.id === item.id ? { ...r, deleted_at: now } : r)) : rs.filter((r) => r.id !== item.id)));
    setTimeout(() => setK((x) => x + 1), 1500);
  };
  // Handed to every Report card: no separate shredder-owned list any more — the shredder is fed
  // directly by dragging the real list row or dossier tile in from the archive itself.
  const shredder = {
    isOver: (x, y) => { const rc = shredRef.current?.rect; return !!rc && x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom; },
    width: () => shredRef.current?.rect?.width,
    drop: (el, item, x, y) => shredRef.current?.feedExternal(el, item, x, y),
  };
  const isWarden = me.role === 'warden';
  return (
    <div className={isWarden ? 'arch' : 'arch solo'}>
      <div>
        <div className="panel">
          <input placeholder="Search the contents of every report..." value={q} onChange={(e) => setQ(e.target.value)} />
          <div>{stats.filter((t) => sel.includes(t.id)).map((t) => <Chip key={t.id} tag={t} n={t.n} on onClick={() => flip(t.id)} />)}
            <button type="button" className="plus" onClick={() => setPicker(true)}>+ Filter by tag</button></div>
          <div className="row"><span className="dim">{rows.length} report(s)</span>
            {sel.length > 0 && <button onClick={() => setSel([])}>Clear filters</button>}
            {isWarden && <label><input type="checkbox" checked={sd} onChange={(e) => setSd(e.target.checked)} /> show redacted</label>}</div>
        </div>
        <div className={view === 'tile' ? 'tiles' : undefined}>
          {rows.map((r) => <Report key={r.id} r={r} me={me} onChange={() => setK((x) => x + 1)} variant={view} shredder={isWarden ? shredder : null} />)}
        </div>
        {picker && <TagPicker tags={stats} on={new Set(sel)} toggle={flip} close={() => setPicker(false)}
          canDelete={isWarden} onDeleted={(id) => { setSel((s) => s.filter((x) => x !== id)); setK((x) => x + 1); }} />}
      </div>
      {isWarden && (
        <aside className="shred-rail">
          <h3>Redaction shredder</h3>
          <p className="dim">Drag a report — a list row or a dossier tile — into the slot to redact it. It stays in the vault; a Warden can restore it, or purge it for good once it's redacted.</p>
          <ErrorBoundary label="The shredder">
            <div className="shredder-mount">
              <Shredder ref={shredRef} items={[]} renderItem={() => null} width={280} height={220}
                fallHeight={140} color={shredColor} slitColor={shredSlit} onShred={shred} />
            </div>
          </ErrorBoundary>
        </aside>
      )}
    </div>
  );
}

function FactionsArchive({ me }) {
  const [list, setList] = useState([]), [newName, setNewName] = useState(''), [err, setErr] = useState('');
  const [memberForm, setMemberForm] = useState(null); // { factionId, id?, name, rank, notes }
  const load = () => api.get('/factions').then(setList);
  useEffect(() => { load(); }, []);
  const createFaction = () => {
    if (!newName.trim()) return;
    api.post('/factions', { name: newName }).then(() => { setNewName(''); load(); }).catch((e) => setErr(e.message));
  };
  const deleteFaction = (id) => api.del(`/factions/${id}`).then(load);
  const setClearance = (id, c) => api.patch(`/factions/${id}/clearance`, { clearance: c }).then(load).catch((e) => setErr(e.message));
  const saveMember = () => {
    const { factionId, id, name, rank, notes } = memberForm;
    const p = id ? api.put(`/faction-members/${id}`, { name, rank, notes }) : api.post(`/factions/${factionId}/members`, { name, rank, notes });
    p.then(() => { setMemberForm(null); load(); }).catch((e) => setErr(e.message));
  };
  const removeMember = (id) => api.del(`/faction-members/${id}`).then(load);
  return (
    <div>
      <div className="panel">
        <h2>Faction rosters</h2>
        <p className="dim">Who's in a faction and their rank — a living list, edited in place by whoever's tracking it, not a case file. A Warden can raise a faction's clearance to seal its roster the same way a report is sealed.</p>
        <div className="row"><input placeholder="New faction name" value={newName} onChange={(e) => setNewName(e.target.value)} /><button onClick={createFaction}>Create faction</button></div>
        {err && <p className="bad">{err}</p>}
      </div>
      {list.map((f) => (
        <div key={f.id} className="panel">
          <div className="row"><h3 style={{ flex: 1 }}>{f.name}</h3>
            {!f.scrambled && <button className="plus" onClick={() => setMemberForm({ factionId: f.id, name: '', rank: '', notes: '' })}>+ Member</button>}
            {me.role === 'warden' && <ClearanceSelect value={f.clearance} onChange={(c) => setClearance(f.id, c)} />}
            {me.role === 'warden' && <HB danger done="Gone" onHold={() => deleteFaction(f.id)}>Hold to disband</HB>}</div>
          {f.scrambled ? (
            <p className="dim">You lack the clearance to view this faction's roster. A Warden can raise your standing clearance, or lower this faction's.</p>
          ) : (
            <table><tbody>
              {f.members.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td><td className="dim">{m.rank}</td><td className="dim">{m.notes}</td>
                  <td className="dim">upd. {stamp(m.updated_at)} by {m.updated_by}</td>
                  <td className="row">
                    <button onClick={() => setMemberForm({ factionId: f.id, id: m.id, name: m.name, rank: m.rank, notes: m.notes })}>Edit</button>
                    <HB danger done="Gone" onHold={() => removeMember(m.id)}>Hold to remove</HB>
                  </td>
                </tr>))}
              {!f.members.length && <tr><td className="dim">No members recorded yet.</td></tr>}
            </tbody></table>
          )}
        </div>))}
      {!list.length && <p className="dim">No factions tracked yet.</p>}
      {memberForm && (
        <div className="modal" onClick={() => setMemberForm(null)}>
          <div className="panel modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>{memberForm.id ? 'Edit member' : 'New member'}</h2>
            <input placeholder="Name" value={memberForm.name} onChange={(e) => setMemberForm({ ...memberForm, name: e.target.value })} />
            <input placeholder="Rank" value={memberForm.rank} onChange={(e) => setMemberForm({ ...memberForm, rank: e.target.value })} />
            <textarea rows={4} placeholder="Notes" value={memberForm.notes} onChange={(e) => setMemberForm({ ...memberForm, notes: e.target.value })} />
            <div className="row"><button className="primary" onClick={saveMember}>Save</button><button onClick={() => setMemberForm(null)}>Cancel</button></div>
          </div>
        </div>)}
    </div>
  );
}

// A note's text types into view the first time its bubble mounts — same "something covert is
// arriving" feel the old scramble effect had, just a plain typewriter now.
function NoteBubble({ n, mine, otherLabel, manage }) {
  const [typed, setTyped] = useState(false);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(n.body);
  const label = n.sender === 'warden' ? 'The Wardens' : (mine ? 'You' : otherLabel);
  const saveEdit = () => {
    if (!draft.trim()) return;
    manage.onEdit(n.id, draft.trim()).then(() => setEditing(false));
  };
  // deleted_at/edited_at only ever come back to a Warden's own thread view (manage truthy) — a
  // member's GET never includes a deleted message at all, or these two fields on any message —
  // so this marker is never visible to the person the note was about.
  const deleted = manage && !!n.deleted_at;
  return (
    <div className={'note-bubble' + (mine ? ' mine' : '') + (deleted ? ' note-deleted' : '')}>
      <div className="note-from dim">
        {label} · {stamp(n.created_at)}
        {manage && !!n.edited_at && !deleted && <span className="note-flag">edited</span>}
        {deleted && <span className="note-flag note-flag-del">deleted — hidden from them</span>}
        {manage && !editing && (
          <span className="note-manage">
            {deleted ? (
              <button className="linklike" onClick={() => manage.onRestore(n.id)}>restore</button>
            ) : (<>
              <button className="linklike" onClick={() => { setDraft(n.body); setEditing(true); }}>edit</button>
              <button className="linklike" onClick={() => manage.onDelete(n.id)}>delete</button>
            </>)}
          </span>
        )}
      </div>
      <div className="note-body">
        {editing ? (
          <div className="row">
            <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); } }} />
            <button className="primary" onClick={saveEdit} disabled={!draft.trim()}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : typed || deleted ? (
          // The typing effect only makes sense for plain text — once it's finished, swap to the
          // same markdown renderer the rest of the app uses, so a note can carry the same
          // formatting (bold, links, spoilers, etc.) as everywhere else. A deleted message skips
          // straight to this (no reason to replay the reveal for something already sent).
          <div className="md" onClick={spoil} dangerouslySetInnerHTML={md(n.body)} />
        ) : (
          <TextType text={n.body} speed={16} onComplete={() => setTyped(true)} />
        )}
      </div>
    </div>
  );
}

function WardenNotes() {
  const [threads, setThreads] = useState([]), [sel, setSel] = useState(null), [thread, setThread] = useState({ hidden: false, messages: [] }), [body, setBody] = useState(''), [err, setErr] = useState('');
  const loadThreads = () => api.get('/notes/threads').then(setThreads);
  useEffect(() => { loadThreads(); }, []);
  const openThread = (t) => {
    setSel(t); setErr('');
    api.get(`/notes/threads/${t.user_id}`).then(setThread).then(loadThreads);
  };
  const refresh = () => sel && api.get(`/notes/threads/${sel.user_id}`).then(setThread).then(loadThreads);
  const send = () => {
    if (!body.trim() || !sel) return;
    api.post(`/notes/threads/${sel.user_id}`, { body }).then(() => { setBody(''); refresh(); }).catch((e) => setErr(e.message));
  };
  const toggleHidden = () => sel && api.patch(`/notes/threads/${sel.user_id}/hidden`, { hidden: !thread.hidden }).then(refresh);
  const manage = {
    onEdit: (mid, editBody) => api.patch(`/notes/threads/${sel.user_id}/messages/${mid}`, { body: editBody }).then(refresh),
    onDelete: (mid) => api.del(`/notes/threads/${sel.user_id}/messages/${mid}`).then(refresh),
    onRestore: (mid) => api.post(`/notes/threads/${sel.user_id}/messages/${mid}/restore`).then(refresh),
  };
  return (
    <div className="notes-wrap">
      <div className="notes-list panel">
        <h3>Chats</h3>
        <p className="dim">Open a chat with any agent. They'll only ever see it came from "The Wardens" — never which one.</p>
        {threads.map((t) => (
          <button key={t.user_id} className={'notes-thread' + (sel?.user_id === t.user_id ? ' on' : '') + (t.hidden ? ' hidden-thread' : '')} onClick={() => openThread(t)}>
            <span>{t.callsign}{t.hidden ? ' (hidden)' : ''}</span>{t.unread > 0 && <b className="notes-badge">{t.unread}</b>}
          </button>))}
        {!threads.length && <p className="dim">No agents yet.</p>}
      </div>
      <div className="notes-thread-pane panel">
        {sel ? (
          <>
            <div className="row">
              <h3>{sel.callsign}</h3>
              <span className="spacer" />
              <button onClick={toggleHidden}>{thread.hidden ? 'Unhide from them' : 'Hide from them'}</button>
            </div>
            {thread.hidden && <p className="dim">This chat is pulled from their Archive — they can't see it, or that it exists.</p>}
            <div className="notes-scroll">
              {thread.messages.map((n) => (
                <NoteBubble key={n.id} n={n} mine={n.sender === 'warden'} otherLabel={sel.callsign}
                  manage={n.sender === 'warden' ? manage : null} />
              ))}
              {!thread.messages.length && <p className="dim">No notes yet. Say something.</p>}
            </div>
            <div className="row">
              <textarea rows={2} placeholder="Write a note..." value={body} onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button className="primary" onClick={send} disabled={!body.trim()}>Send</button>
            </div>
            {err && <p className="bad">{err}</p>}
          </>
        ) : <p className="dim">Pick an agent to open a chat.</p>}
      </div>
    </div>
  );
}

function MemberNotes({ onRead }) {
  const [msgs, setMsgs] = useState([]), [body, setBody] = useState(''), [err, setErr] = useState('');
  // Opening this tab is what marks the Wardens' messages read server-side (GET /notes/mine) — bump
  // the tab's own status right after, rather than waiting for its next slow poll, so the badge
  // clears the moment the member actually opens the tab, as asked.
  const load = () => api.get('/notes/mine').then((m) => { setMsgs(m); onRead?.(); });
  useEffect(() => { load(); }, []);
  const send = () => {
    if (!body.trim()) return;
    api.post('/notes/mine', { body }).then(() => { setBody(''); load(); }).catch((e) => setErr(e.message));
  };
  return (
    <div className="notes-thread-pane panel">
      <h3>Notes from the Wardens</h3>
      <p className="dim">Only you and the Wardens can see this — and you'll never know which Warden sent a note.</p>
      <div className="notes-scroll">
        {msgs.map((n) => <NoteBubble key={n.id} n={n} mine={n.sender === 'member'} />)}
        {!msgs.length && <p className="dim">Nothing yet.</p>}
      </div>
      <div className="row">
        <textarea rows={2} placeholder="Reply..." value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="primary" onClick={send} disabled={!body.trim()}>Send</button>
      </div>
      {err && <p className="bad">{err}</p>}
    </div>
  );
}

function NotesArchive({ me, onRead }) {
  return me.role === 'warden' ? <WardenNotes /> : <MemberNotes onRead={onRead} />;
}

// A member's Notes tab stays out of the nav entirely until a Warden has messaged them first — there's
// nothing to open before that, so there's nothing to show. This also drives the tab's unread badge,
// polled lightly and cleared immediately (via the returned refresh()) the moment MemberNotes' own
// GET /notes/mine marks everything read, rather than waiting for the next slow poll.
export function useNotesStatus(me) {
  const [status, setStatus] = useState({ open: me.role === 'warden', unread: 0 });
  const refresh = () => api.get('/notes/status').then(setStatus).catch(() => {});
  useEffect(() => {
    if (me.role === 'warden') return;
    let stop = false;
    const poll = () => api.get('/notes/status').then((s) => { if (!stop) setStatus(s); }).catch(() => {});
    poll();
    const id = setInterval(poll, 15000);
    return () => { stop = true; clearInterval(id); };
  }, [me.role]);
  return [status, refresh];
}

export function Archive({ me, sel, setSel, sub, setSub, openTag }) {
  const [view, setView] = useState('list');
  const [notesStatus, refreshNotesStatus] = useNotesStatus(me);
  const notesOpen = me.role === 'warden' || notesStatus.open;
  const tabs = [['reports', 'Reports'], ['pois', 'Persons of interest'], ['factions', 'Factions'], ...(notesOpen ? [['notes', 'Notes']] : [])];
  useEffect(() => { if (sub === 'notes' && !notesOpen) setSub('reports'); }, [notesOpen, sub, setSub]);
  const noListView = sub === 'factions' || sub === 'notes';
  return (
    <ErrorBoundary label="The archive">
      <div className="row subnav">
        {tabs.map(([k, l]) => (
          <button key={k} className={sub === k ? 'tab on' : 'tab'} onClick={() => setSub(k)}>
            {l}{k === 'notes' && me.role !== 'warden' && notesStatus.unread > 0 && <b className="notes-badge">{notesStatus.unread}</b>}
          </button>))}
        <span className="spacer" />
        {!noListView && (<>
          <button className={view === 'list' ? 'tab on' : 'tab'} onClick={() => setView('list')}>List</button>
          <button className={view === 'tile' ? 'tab on' : 'tab'} onClick={() => setView('tile')}>Dossiers</button>
        </>)}
      </div>
      {sub === 'reports' ? <ReportsArchive me={me} sel={sel} setSel={setSel} view={view} />
        : sub === 'pois' ? <PoisArchive me={me} openTag={openTag} view={view} />
        : sub === 'factions' ? <FactionsArchive me={me} />
        : notesOpen ? <NotesArchive me={me} onRead={refreshNotesStatus} /> : null}
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
  const [open, setOpen] = useState(false), [tab, setTab] = useState('look'), [spin, setSpin] = useState(0);
  const toggle = () => {
    setSpin((s) => s + 1); // re-keys the icon so its spin animation replays every click, open or close
    if (open) setOpen(false); else setTimeout(() => setOpen(true), 220); // let the cog finish turning before the panel pops out
  };
  return (
    <div className="cog">
      <AnimatePresence>{open && (
        <motion.div className="panel cog-pop" initial={{ opacity: 0, scale: .85, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: .85, y: 10 }} transition={{ type: 'spring', damping: 22, stiffness: 320 }}>
          <div className="row subnav" style={{ marginBottom: 10 }}>
            <button className={tab === 'look' ? 'tab on' : 'tab'} onClick={() => setTab('look')}>Appearance</button>
            <button className={tab === 'acct' ? 'tab on' : 'tab'} onClick={() => setTab('acct')}>Account</button>
          </div>
          {tab === 'look' ? (
            <>
              <h3>Palette</h3>
              <Sel ariaLabel="Palette" value={settings.theme} onChange={(v) => save({ ...settings, theme: v })}
                options={Object.entries(THEMES).map(([k, t]) => ({ value: k, label: t.label }))} />
              <h3>Typeface</h3>
              <Sel ariaLabel="Typeface" value={settings.font} onChange={(v) => save({ ...settings, font: v })}
                options={Object.entries(FONTS).map(([k, l]) => ({ value: k, label: l }))} />
              <label className="row" style={{ marginTop: 12 }}><input type="checkbox" checked={settings.animate !== false}
                onChange={(e) => save({ ...settings, animate: e.target.checked })} /> Animate the background</label>
              <label className="row"><input type="checkbox" checked={settings.clickSpark !== false}
                onChange={(e) => save({ ...settings, clickSpark: e.target.checked })} /> Spark on click</label>
              <p className="dim">Saved to your callsign.</p>
            </>
          ) : <AccountPane me={me} setMe={setMe} />}
        </motion.div>)}</AnimatePresence>
      <button className="cog-btn" onClick={toggle} aria-label="Settings" aria-expanded={open}>
        <motion.span key={spin} style={{ display: 'inline-flex' }} initial={{ rotate: 0 }} animate={{ rotate: 360 }} transition={{ duration: .55, ease: 'easeInOut' }}>
          <Cog size={22} />
        </motion.span>
      </button>
    </div>
  );
}

const HB = ({ children, done, danger, onHold }) => (
  <HoldButton size="sm" radius={6} holdTime={danger ? 1800 : 1200} doneLabel={done} backgroundColor="var(--cell)" textColor="var(--ink)"
    fillColor={danger ? '#a33a34' : '#4f8f86'} glow={false} resetAfter={500} onHold={onHold}>{children}</HoldButton>
);

export function Personnel({ me }) {
  const [u, setU] = useState([]), [err, setErr] = useState('');
  const load = () => api.get('/users').then(setU);
  useEffect(() => { load(); }, []);
  const role = (id, r) => api.patch('/users/' + id, { role: r }).then(() => { setErr(''); load(); }).catch((e) => setErr(e.message));
  const clearance = (id, c) => api.patch('/users/' + id + '/clearance', { clearance: c }).then(() => { setErr(''); load(); }).catch((e) => setErr(e.message));
  const deny = (id) => api.del('/users/' + id).then(() => { setErr(''); load(); }).catch((e) => setErr(e.message));
  return (
    <>
      <div className="panel"><h2>Personnel</h2><p className="dim">Hold a button to confirm. A tap does nothing.</p>
        {err && <p className="bad">{err}</p>}
        <table><tbody>{u.map((x) => (
          <tr key={x.id}><td>{x.callsign}</td><td className="dim">{x.role}</td>
            <td>{x.id !== me.id && x.role !== 'pending' && (
              <Sel ariaLabel={`Clearance for ${x.callsign}`} size="sm" value={x.clearance} onChange={(v) => clearance(x.id, v)}
                options={CLEARANCE_LABEL.map((l, i) => ({ value: i, label: l }))} />)}</td>
            <td className="dim">{stamp(x.created_at)}</td>
            <td>{x.id !== me.id && (<div className="row">
              {x.role === 'pending' && <><HB done="Approved" onHold={() => role(x.id, 'agent')}>Hold to approve</HB><HB danger done="Denied" onHold={() => deny(x.id)}>Hold to deny</HB></>}
              {x.role === 'agent' && <><HB done="Promoted" onHold={() => role(x.id, 'warden')}>Hold to promote</HB><HB danger done="Suspended" onHold={() => role(x.id, 'pending')}>Hold to suspend</HB></>}
              {x.role === 'warden' && <HB danger done="Demoted" onHold={() => role(x.id, 'agent')}>Hold to demote</HB>}
            </div>)}</td></tr>))}</tbody></table>
      </div>
    </>
  );
}

function PoiCard({ p, me, reload, openTag, variant = 'list' }) {
  const [open, setOpen] = useState(false), [rows, setRows] = useState([]), [form, setForm] = useState(null), [err, setErr] = useState('');
  const loadRows = () => api.get(`/reports?tags=${p.id}&limit=100`).then(setRows);
  useEffect(() => { if (open) loadRows(); }, [open]);
  const save = () => api.put('/pois/' + p.id, form).then(() => { setForm(null); reload(); loadRows(); }).catch((e) => setErr(e.message));
  const redacted = !!p.deleted_at;
  const setRedaction = (on) => api.post(`/pois/${p.id}/${on ? 'redact' : 'restore'}`).then(reload).catch((e) => setErr(e.message));
  const setClearance = (c) => api.patch(`/pois/${p.id}/clearance`, { clearance: c }).then(reload).catch((e) => setErr(e.message));
  const purge = () => api.del(`/pois/${p.id}/purge`).then(() => { setOpen(false); reload(); }).catch((e) => setErr(e.message));
  const blurb = redacted ? 'This file has been redacted.' : p.scrambled ? 'Beyond your clearance.' : (excerpt(p.description) || 'No description yet.');
  const card = variant === 'tile' ? (
    <Dossier id={p.id} prefix="p" tag="Person of interest" title={p.name}
      meta={`${p.n} report(s)${p.aliases ? `, AKA ${p.aliases}` : ''}`} excerpt={blurb} redacted={redacted || p.scrambled} onOpen={() => setOpen(true)} />
  ) : (
    <motion.article layoutId={'p' + p.id} transition={SHEET_SPRING} className={'report card' + (redacted || p.scrambled ? ' redacted' : '')} role="button" tabIndex={0} onClick={() => setOpen(true)} onKeyDown={(e) => e.key === 'Enter' && setOpen(true)}>
      <h3>{p.name}</h3>
      <p className="meta">{p.n} report(s){p.aliases && `, also known as ${p.aliases}`}</p>
      <p className="clamp">{blurb}</p>
      {redacted && <span className="dossier-stamp">REDACTED</span>}
      {!redacted && p.scrambled && <span className="dossier-stamp">SEALED</span>}
    </motion.article>
  );
  return (
    <>
      {!open && card}
      <AnimatePresence>{open && (
        <Overlay id={'p' + p.id} close={() => setOpen(false)}>
          <h2>{p.name}</h2>
          {p.aliases && <p className="meta">Also known as {p.aliases}</p>}
          <p className="meta">{rows.length} report(s){rows.length > 0 && `. First seen ${stamp(rows.at(-1).created_at)}. Last seen ${stamp(rows[0].created_at)}`}{redacted && '. Redacted'}</p>
          {p.scrambled && !redacted && (
            <p className="dim">This file exists, but you're not cleared to read it. A Warden can raise your standing clearance, or lower this file's.</p>
          )}
          {form ? (
            <div className="form"><input placeholder="Aliases, separated by commas (also tagged automatically)" value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
              <textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              {err && <p className="bad">{err}</p>}
              <div className="row"><button className="primary" onClick={save}>Save</button><button onClick={() => setForm(null)}>Cancel</button></div></div>
          ) : (!p.scrambled || redacted) && (
            <>
              <div className="md" onClick={spoil} dangerouslySetInnerHTML={md((redacted ? '*This file has been redacted. Its contents are hidden and its tag no longer applies to reports.*' : p.description) || '*No description yet.*')} />
              <div className="row">
                {!redacted && <button onClick={() => setForm(p)}>Edit file</button>}
                <button className="primary" onClick={() => { setOpen(false); openTag([p.id]); }}>Read their reports</button>
                {me.role === 'warden' && (redacted
                  ? <><HB done="Restored" onHold={() => setRedaction(false)}>Hold to restore</HB>
                      <HB danger done="Purged" onHold={purge}>Hold to purge forever</HB></>
                  : <HB danger done="Redacted" onHold={() => setRedaction(true)}>Hold to redact</HB>)}
              </div>
            </>)}
          {me.role === 'warden' && !redacted && (
            <p className="dim">Clearance: <ClearanceSelect value={p.clearance ?? MAX_CLEARANCE} onChange={setClearance} /></p>
          )}
          {err && <p className="bad">{err}</p>}
          <h3>Timeline</h3>
          {rows.map((r) => <div key={r.id} className="mini"><b>{r.title}</b><span className="meta">{stamp(r.created_at)}, {r.author} <Meta conf={r.confidence} /></span></div>)}
        </Overlay>)}</AnimatePresence>
    </>
  );
}

function PoisArchive({ me, openTag, view }) {
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
          <button className="plus" onClick={() => setForm({ name: '', aliases: '', description: '', clearance: MAX_CLEARANCE })}>+ New person</button>
          {me.role === 'warden' && <label><input type="checkbox" checked={sd} onChange={(e) => setSd(e.target.checked)} /> show redacted</label>}</div>
        {form && (
          <div className="form"><input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="Aliases, separated by commas" value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
            <textarea rows={5} placeholder="Description, allegiances, habits. Markdown works." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            {me.role === 'warden' && <ClearanceSelect value={form.clearance} onChange={(c) => setForm({ ...form, clearance: c })} />}
            <p className="dim">{me.role === 'warden'
              ? 'A file always opens at Warden-only clearance unless lowered here.'
              : 'This file opens at Warden-only clearance — a Warden can open it up afterward.'}</p>
            {err && <p className="bad">{err}</p>}
            <div className="row"><button className="primary" onClick={create}>Open file</button><button onClick={() => setForm(null)}>Cancel</button></div></div>)}
      </div>
      <div className={view === 'tile' ? 'tiles' : undefined}>
        {shown.map((p) => <PoiCard key={p.id} p={p} me={me} reload={load} openTag={openTag} variant={view} />)}
      </div>
      {!list.length && <p className="dim">No files yet. Anyone named in a report is tagged as soon as they have one.</p>}
    </div>
  );
}
