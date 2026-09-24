import { useEffect, useState } from 'react';
import ClickSpark from './components/ClickSpark/ClickSpark';
import Dither from './components/Dither/Dither';
import { THEMES, BG, hexToRgb01 } from './themes';
import DecryptedText from './components/Decrypting/decryptText';
import BorderGlow from './components/BorderGlow/BorderGlow';
import { api } from './api';
import ErrorBoundary from './components/ErrorBoundary';
import { Clock, Dashboard, Compose, Archive, Personnel, SettingsCog } from './views';
import './index.css';

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
      <BorderGlow backgroundColor="#131315" glowColor="40 50 60" colors={['#b6913e', '#a83a32', '#4c8d82']} borderRadius={10}>
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
  const [me, setMe] = useState(undefined), [view, setView] = useState('dash'), [sel, setSel] = useState([]), [sub, setSub] = useState('reports');
  const [settings, setSettings] = useState({ theme: 'nocturne', font: 'ledger', animate: true, clickSpark: true });
  useEffect(() => { api.get('/me').then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => { if (me) api.get('/settings').then(setSettings).catch(() => {}); }, [me]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; document.documentElement.dataset.font = settings.font; }, [settings]);
  const save = (s) => { setSettings(s); api.put('/settings', s); };
  const openTag = (ids) => { setSel(ids); setSub('reports'); setView('arch'); };
  const T = THEMES[settings.theme] || THEMES.nocturne;
  const tabs = [['dash', 'Dashboard'], ['file', 'File report'], ['arch', 'Archive'], ...(me?.role === 'warden' ? [['users', 'Personnel']] : [])];
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
      {view === 'dash' && <Dashboard me={me} setView={setView} openTag={openTag} />}
      {view === 'file' && <Compose me={me} done={() => setView('arch')} />}
      {view === 'arch' && <Archive me={me} sel={sel} setSel={setSel} sub={sub} setSub={setSub} openTag={openTag} />}
      {view === 'users' && me.role === 'warden' && <Personnel me={me} />}
    </div>
  );
  const content = (
    <>
      <ErrorBoundary silent>
        <div className="bg-fixed">
          <Dither
            waveColor={hexToRgb01(T.spark)} backgroundColor={hexToRgb01(BG[settings.theme] || BG.nocturne)}
            waveSpeed={0.04} waveFrequency={2.4} waveAmplitude={0.28} colorNum={4} pixelSize={2}
            disableAnimation={settings.animate === false} enableMouseInteraction={false}
          />
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
