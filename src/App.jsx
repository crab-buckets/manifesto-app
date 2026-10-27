import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import ClickSpark from './components/ClickSpark/ClickSpark';
import { THEMES, BG, hexToRgb01 } from './themes';
import BorderGlow from './components/BorderGlow/BorderGlow';
import TextType from './components/TextType/TextType';
// Dither (the animated background) is the only thing left in this app that pulls in three.js — plus
// @react-three/fiber and @react-three/postprocessing on top of that — and by far the heaviest
// dependency in the whole bundle. It's purely decorative (a shader background), so it's lazy-loaded
// into its own chunk instead of shipping in the main bundle every visit. (ASCIIText, the other
// three.js-based component, no longer runs on this screen — the login logo below is TextType now.)
const Dither = lazy(() => import('./components/Dither/Dither'));
import { api } from './api';
import ErrorBoundary from './components/ErrorBoundary';
import { Clock, Dashboard, Compose, Archive, Personnel, Feedback, SettingsCog } from './views';
import './index.css';

// The public face of the site, before anyone has signed in, a mundane cover, same as every
// account's own cover name, and never the real name. Keep this in sync with the <title> in
// index.html, which can't import this file, so a change here needs a matching change there.
export const PUBLIC_BRAND = 'The Ledger';

function Auth({ onIn }) {
  const [mode, setMode] = useState('in'), [callsign, setC] = useState(''), [passphrase, setP] = useState(''), [msg, setMsg] = useState('');
  // A rotating splash line — two fixed messages, then a server-picked random one — cycles on the
  // login screen the same way a game's loading-screen tips do. The random line is refetched each
  // time the cycle laps back to the start (TextType's onCycleComplete, below), so it isn't the same
  // one line forever; `/api/splash` is public (no `need()`) since this renders before anyone signs in.
  const [splash, setSplash] = useState('');
  const fetchSplash = () => { api.get('/splash').then((d) => setSplash(d.message || '')).catch(() => {}); };
  // Wrapped in a block body (not passed directly) so the effect callback returns undefined, not the
  // Promise chain — an effect returning anything other than a function or undefined gets treated as
  // if it returned a cleanup ("destroy") function, and crashes when React actually tries to call it.
  useEffect(fetchSplash, []);
  // Memoized on `splash` alone so this array keeps the same reference across unrelated re-renders
  // (typing a callsign, say) — TextType relies on that to avoid restarting the cycle mid-type.
  // `.filter(Boolean)` drops the splash slot entirely until the first fetch resolves.
  const splashLines = useMemo(() => [`Welcome to ${PUBLIC_BRAND}.`, splash, 'Speak your callsign.', splash].filter(Boolean), [splash]);
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
      <div className="ascii-logo" aria-hidden="true">
        <TextType text={splashLines} typingSpeed={40} deletingSpeed={50} pauseDuration={5000}
          cursorCharacter="_" cursorBlinkDuration={0.5} onCycleComplete={fetchSplash} />
      </div>
      <h1 className="sr-only">{PUBLIC_BRAND}</h1>
      <BorderGlow backgroundColor="#131315" glowColor="40 50 60" colors={['#b6913e', '#a83a32', '#4c8d82']} borderRadius={10}>
        <div className="glow-pad">
          <input placeholder="Callsign" value={callsign} onChange={(e) => setC(e.target.value)} autoComplete="username" />
          <input type="password" placeholder="Passphrase (8+ characters)" value={passphrase} onChange={(e) => setP(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
          {msg && <p className="bad">{msg}</p>}
          <button className="primary" onClick={go}>{mode === 'in' ? 'Enter' : 'Request access'}</button>
          <button onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg(''); }}>
            {mode === 'in' ? 'Sign up' : 'Have a callsign? Sign in'}</button>
          <p className="dim">Speak your callsign. Ask nothing more.</p>
        </div>
      </BorderGlow>
    </main>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined), [view, setView] = useState('dash'), [sel, setSel] = useState([]), [sub, setSub] = useState('reports');
  const [settings, setSettings] = useState({ theme: 'nocturne', font: 'ledger', animate: true, clickSpark: true });
  useEffect(() => { api.get('/me').then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => { if (me) api.get('/settings').then(setSettings).catch(() => {}); }, [me]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; document.documentElement.dataset.font = settings.font; }, [settings]);
  // The tab title starts as the public cover, PUBLIC_BRAND (set in index.html) once signed in it
  // switches to this account's own brand: a cover name below the reveal clearance, "Manifesto" at
  // or above it. Signing out puts the public cover back.
  useEffect(() => { document.title = me ? me.brand : PUBLIC_BRAND; }, [me]);
  const save = (s) => { setSettings(s); api.put('/settings', s); };
  const openTag = (ids) => { setSel(ids); setSub('reports'); setView('arch'); };
  const T = THEMES[settings.theme] || THEMES.nocturne;
  const tabs = [['dash', 'Dashboard'], ['file', 'File report'], ['arch', 'Archive'], ...(me?.role === 'warden' ? [['users', 'Personnel']] : []), ['feedback', 'Feedback']];
  let body = null;
  if (me === null) body = <Auth onIn={setMe} />;
  else if (me) body = (
    <div className="shell">
      <header>
        <span className="brand">{me.brand || 'Manifesto'}</span>
        <nav>{tabs.map(([k, l]) => (
          <button key={k} className={view === k ? 'tab on' : 'tab'} onClick={() => { setView(k); if (k !== 'arch') setSel([]); }}>{l}</button>))}</nav>
        <Clock />
        <span className="dim">{me.callsign}, {me.role} <button onClick={() => api.post('/auth/logout').then(() => setMe(null))}>Leave</button></span>
      </header>
      {view === 'dash' && <Dashboard me={me} setView={setView} openTag={openTag} />}
      {view === 'file' && <Compose me={me} done={() => setView('arch')} />}
      {view === 'arch' && <Archive me={me} sel={sel} setSel={setSel} sub={sub} setSub={setSub} openTag={openTag} />}
      {view === 'users' && me.role === 'warden' && <Personnel me={me} />}
      {view === 'feedback' && <Feedback me={me} />}
    </div>
  );
  const content = (
    <>
      <ErrorBoundary silent>
        <div className="bg-fixed">
          <Suspense fallback={null}>
            <Dither
              waveColor={hexToRgb01(T.spark)} backgroundColor={hexToRgb01(BG[settings.theme] || BG.nocturne)}
              waveSpeed={0.04} waveFrequency={2.4} waveAmplitude={0.28} colorNum={4} pixelSize={2}
              disableAnimation={settings.animate === false} enableMouseInteraction={false}
            />
          </Suspense>
        </div>
      </ErrorBoundary>
      <ErrorBoundary label="Manifesto">{body}</ErrorBoundary>
      {me && <SettingsCog settings={settings} save={save} me={me} setMe={setMe} />}
    </>
  );
  return settings.clickSpark === false ? content : (
    <ClickSpark sparkColor={T.spark} sparkCount={10} sparkRadius={24} duration={500}>{content}</ClickSpark>
  );
}
