import { lazy, Suspense, useEffect, useState } from 'react';
import ClickSpark from './components/ClickSpark/ClickSpark';
import Dither from './components/Dither/Dither';
import logo from './assets/Manifesto-Logo.webp';
import { THEMES } from './themes';
import DecryptedText from './components/Decrypting/decryptText';
import BorderGlow from './components/BorderGlow/BorderGlow';
import { api } from './api';
import { Clock, Dashboard, Compose, Archive, Personnel, Settings, Pois } from './views';
import './index.css';

// card.glb and lanyard.png live in src/assets/lanyard (imported by lanyard.jsx).
const Lanyard = lazy(() => import('./components/Lanyard/lanyard'));
const useMedia = (q) => {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => { const l = matchMedia(q), f = () => setM(l.matches); l.addEventListener('change', f); return () => l.removeEventListener('change', f); }, [q]);
  return m;
};

function Auth({ onIn }) {
  const [mode, setMode] = useState('in'), [callsign, setC] = useState(''), [passphrase, setP] = useState(''), [msg, setMsg] = useState('');
  const go = async () => {
    setMsg('');
    try {
      if (mode === 'up') {
        const r = await api.post('/auth/signup', { callsign, passphrase });
        if (r.status === 'pending') { setMsg('Request lodged. A Warden must approve you before you can enter.'); return setMode('in'); }
      } else await api.post('/auth/login', { callsign, passphrase });
      onIn(await api.get('/me'));
    } catch (e) { setMsg(e.message); }
  };
  return (
    <main className="auth">
      <h1><DecryptedText text="MANIFESTO" animateOn="view" sequential speed={90} /></h1>
      <p className="dim">Speak your callsign. Ask nothing more.</p>
      <BorderGlow backgroundColor="#171d25" glowColor="40 50 60" colors={['#b08d3c', '#a33a34', '#4f8f86']} borderRadius={10}>
        <div className="glow-pad">
          <input placeholder="Callsign" value={callsign} onChange={(e) => setC(e.target.value)} autoComplete="username" />
          <input type="password" placeholder="Passphrase (8+ characters)" value={passphrase} onChange={(e) => setP(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
          {msg && <p className="bad">{msg}</p>}
          <button className="primary" onClick={go}>{mode === 'in' ? 'Enter' : 'Request access'}</button>
          <button onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg(''); }}>
            {mode === 'in' ? 'New here? Sign up' : 'Have a callsign? Sign in'}</button>
          <p className="dim">The first callsign ever lodged becomes the Warden.</p>
        </div>
      </BorderGlow>
    </main>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined), [view, setView] = useState('dash'), [sel, setSel] = useState([]);
  const [settings, setSettings] = useState({ theme: 'nocturne', font: 'ledger' });
  const big = useMedia('(min-width: 1800px) and (min-height: 1000px)'), still = useMedia('(prefers-reduced-motion: reduce)');
  useEffect(() => { api.get('/me').then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => { if (me) api.get('/settings').then(setSettings).catch(() => {}); }, [me]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; document.documentElement.dataset.font = settings.font; }, [settings]);
  const save = (s) => { setSettings(s); api.put('/settings', s); };
  const T = THEMES[settings.theme] || THEMES.nocturne;
  const tabs = [['dash', 'Dashboard'], ['file', 'File report'], ['arch', 'Archive'], ['poi', 'Persons of interest'], ...(me?.role === 'warden' ? [['users', 'Personnel']] : []), ['set', 'Settings']];
  let body = null;
  if (me === null) body = <Auth onIn={setMe} />;
  else if (me) body = (
    <div className="shell">
      <header>
        <span className="brand">Manifesto</span>
        <nav>{tabs.map(([k, l]) => (
          <button key={k} className={view === k ? 'tab on' : 'tab'} onClick={() => { setView(k); if (k !== 'arch') setSel([]); }}>{l}</button>))}</nav>
        <Clock />
        <span className="dim">{me.callsign}, {me.role} <button onClick={() => api.post('/auth/logout').then(() => setMe(null))}>Leave</button></span>
      </header>
      {view === 'dash' && <Dashboard me={me} setView={setView} openTag={(ids) => { setSel(ids); setView('arch'); }} />}
      {view === 'file' && <Compose done={() => setView('arch')} />}
      {view === 'arch' && <Archive me={me} sel={sel} setSel={setSel} />}
      {view === 'poi' && <Pois me={me} />}
      {view === 'users' && me.role === 'warden' && <Personnel me={me} />}
      {view === 'set' && <Settings settings={settings} save={save} />}
    </div>
  );
  return (
    <ClickSpark sparkColor={T.spark} sparkCount={10} sparkRadius={24} duration={500}>
      <div className="bg-dither" aria-hidden="true">
        <Dither waveColor={T.dither} backgroundColor={T.bg} pixelSize={3} waveSpeed={0.02} colorNum={4} disableAnimation={still} enableMouseInteraction={false} />
      </div>
      {me && big && <Suspense fallback={null}><div className="lanyard-fixed"><Lanyard position={[0, 0, 20]} fov={20} frontImage={logo} backImage={logo} imageFit="contain" /></div></Suspense>}
      {body}
    </ClickSpark>
  );
}
