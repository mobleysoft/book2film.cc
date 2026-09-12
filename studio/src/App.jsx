import { useRef, useState } from 'react';

const steps = ['extract', 'summarize', 'compose', 'render', 'complete'];
const titles = { uploading: 'Saving manuscript', extract: 'Reading the next page', summarize: 'Distilling the narrative', compose: 'Shaping twelve scene beats', render: 'Rendering the pitch reel', complete: 'Ready for your editorial review' };
function download(name, value, type) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export default function App() {
  const [token, setToken] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [file, setFile] = useState(null), [rights, setRights] = useState(false);
  const [jobs, setJobs] = useState([]), [job, setJob] = useState(null), [running, setRunning] = useState(false);
  const [working, setWorking] = useState(false), [error, setError] = useState(''), [page, setPage] = useState(null);
  const [replay, setReplay] = useState(0);
  const continueRun = useRef(false), uploadKey = useRef(crypto.randomUUID());
  async function api(path, options = {}, bearer = token) {
    const response = await fetch(path, { ...options, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...options.headers } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }
  async function refresh(bearer = token) {
    const result = await api('/api/book2film/jobs', {}, bearer); setJobs(result.jobs); return result.jobs;
  }
  async function login(event) {
    event.preventDefault(); setError(''); setWorking(true);
    try {
      const result = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      setToken(result.token); setPassword('');
      const saved = await refresh(result.token); setJob(saved[0] || null);
    } catch (e) { setError(e.message); } finally { setWorking(false); }
  }
  async function upload(event) {
    event.preventDefault(); if (!file || !rights) return;
    if (file.size > 10 * 1024 * 1024) { setError('This pilot accepts PDFs up to 10 MiB.'); return; }
    setWorking(true); setError(''); setPage(null);
    try {
      const result = await api('/api/book2film/adapt', { method: 'POST', headers: {
        'Content-Type': 'application/pdf', 'Idempotency-Key': uploadKey.current, 'X-Rights-Confirmed': 'true',
        'X-Manuscript-Name': file.name.replace(/[^\x20-\x7E]/g, '_'),
      }, body: file });
      setJob(result.job); await refresh();
    } catch (e) { setError(e.message); } finally { setWorking(false); }
  }
  async function run() {
    if (!job || running) return;
    continueRun.current = true; setRunning(true); setError('');
    let current = job;
    try {
      // One checkpoint per request. Closing the tab pauses this client-driven
      // runner; the server's saved job remains available after signing in again.
      while (continueRun.current && current.stage !== 'complete') {
        const result = await api(`/api/book2film/jobs/${current.id}/advance`, { method: 'POST' });
        current = result.job; setJob(current);
      }
      await refresh();
    } catch (e) {
      setError(e.message);
      try { const saved = await api(`/api/book2film/jobs/${current.id}`); setJob(saved.job); } catch { /* Original error remains visible. */ }
    } finally { continueRun.current = false; setRunning(false); }
  }
  async function remove() {
    if (!job || !window.confirm('Delete this manuscript, OCR text and adaptation from the studio?')) return;
    setWorking(true); setError('');
    try { await api(`/api/book2film/jobs/${job.id}`, { method: 'DELETE' }); setJob(null); setPage(null); await refresh(); }
    catch (e) { setError(e.message); } finally { setWorking(false); }
  }
  async function inspect(n) {
    setError(''); try { setPage(await api(`/api/book2film/jobs/${job.id}/pages/${n}`)); }
    catch (e) { setError(e.message); }
  }
  const result = job?.result, disabled = running || working;
  const preview = result ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:#10151c}svg{display:block;width:100%;height:auto}</style>${result.video.svg}` : '';
  return <div className="min-h-screen">
    <header className="masthead flex flex-wrap items-center justify-between gap-4">
      <a className="brand" href="#studio" aria-label="Book2Film studio"><span className="brand-mark">B<span>2</span>F</span><span>book2film<span className="brand-domain">.cc</span></span></a>
      <div className="eyebrow">A MobleySoft venture <span className="pilot">Operator pilot</span></div>
    </header>
    <main id="studio">
      <section className="hero grid gap-10 lg:grid-cols-2">
        <div className="hero-copy"><p className="eyebrow accent">The adaptation workbench / 001</p><h1>Every great film<br/>begins <em>somewhere.</em></h1><p className="lede">Find the screen story inside your manuscript. Twelve proposed scene beats. One moving pitch reel. Your judgment, at every turn.</p>
          <a href="#workspace" className="start-link">Enter the studio <span aria-hidden="true">&#8599;</span></a>
          <p className="boundary">An editorial starting point, not an automated finished film.</p></div>
        <div className="hero-art" aria-hidden="true"><div className="paper"><span>MANUSCRIPT</span><div className="paper-lines"/><i>From the page.</i></div><div className="frame"><span>01 / 12</span><div className="frame-corner"/><strong>To possibility.</strong><small>BOOK2FILM / EDITORIAL STUDIO</small></div></div>
      </section>
      <div className="capability-strip grid grid-cols-1 gap-4 sm:grid-cols-3"><div><b>01</b> Read <span>Weyland OCR</span></div><div><b>02</b> Adapt <span>Local Qwen</span></div><div><b>03</b> Present <span>Filmline storyboard</span></div></div>
      <section id="workspace" className="workspace grid gap-8 lg:grid-cols-[320px_1fr]">
        <aside className="controls">
          <p className="eyebrow accent">Your source material</p><h2>The manuscript desk.</h2>
          {!token ? <form onSubmit={login} className="space-y-4">
            <p>Sign in with an approved AuthFor account. Credentials are not stored in this browser.</p>
            <label>Email<input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required/></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/></label>
            <button className="primary" disabled={working}>Sign in to the pilot</button>
          </form> : <>
            <p className="session">AuthFor session active <button disabled={disabled} onClick={() => { setToken(''); setJobs([]); setJob(null); setPage(null); }}>Sign out</button></p>
            <form onSubmit={upload} className="space-y-5">
              <label className="upload">Choose manuscript PDF<input type="file" accept="application/pdf,.pdf" disabled={disabled} onChange={e => { setFile(e.target.files?.[0] || null); uploadKey.current = crypto.randomUUID(); }}/><small>10 MiB / up to 120 pages / English OCR</small></label>
              <label className="check"><input type="checkbox" checked={rights} disabled={disabled} onChange={e => setRights(e.target.checked)}/><span>I own this work or have permission to upload and adapt it.</span></label>
              <button className="primary" disabled={disabled || !file || !rights}>Save manuscript</button>
            </form>
            {jobs.length > 0 && <label className="saved">Saved projects<select aria-label="Saved projects" disabled={disabled} value={job?.id || ''} onChange={e => { setJob(jobs.find(j => j.id === e.target.value)); setPage(null); setError(''); }}><option value="" disabled>Select project</option>{jobs.map(j => <option key={j.id} value={j.id}>{j.name} / {j.stage}</option>)}</select></label>}
          </>}
          <div className="storage-note"><h3>Private by design. Bounded by reality.</h3><p>PDFs and OCR text go to private Cloudflare storage; model requests go to our local Qwen gateway. No Claude API fallback. Nothing is published automatically.</p><p>Files remain until you delete the project. Closing this tab pauses processing after the current request; sign in again to resume.</p><p>Longer books need the next capacity milestone. This pilot does not silently adapt only their opening pages.</p></div>
        </aside>
        <div className="review">
          <div className="review-heading flex flex-wrap items-start justify-between gap-4"><div><p className="eyebrow">Editorial review</p><h2>{job ? job.name : 'A blank screen. A new possibility.'}</h2></div><span className="pilot">{job ? job.stage : 'Awaiting manuscript'}</span></div>
          {error && <div role="alert" className="error">{error}</div>}
          {job ? <>
            <div className="progress" role="status" aria-live="polite"><strong>{titles[job.stage]}</strong><p>Pages extracted: {job.extracted_pages} / {job.document_pages || '?'} &middot; Summarized: {job.summarized_pages}</p><div className="stages">{steps.map(s => <span key={s} className={job.stage === s ? 'active' : ''}>{s}</span>)}</div></div>
            <div className="actions flex flex-wrap gap-3">
              {job.stage !== 'complete' && <button className="primary" disabled={disabled || job.stage === 'uploading'} onClick={run}>{job.error ? 'Retry saved checkpoint' : 'Continue adaptation'}</button>}
              {running && <button onClick={() => { continueRun.current = false; }}>Pause after this checkpoint</button>}
              <button disabled={disabled} onClick={remove}>Delete project</button>
            </div>
            {result && <>
              <div className="reel"><iframe key={replay} sandbox="" title="Animated storyboard preview" srcDoc={preview}/></div>
              <div className="actions flex flex-wrap gap-3"><button onClick={() => setReplay(r => r + 1)}>Replay scene cards</button><button onClick={() => download('book2film-treatment.json', JSON.stringify(result, null, 2), 'application/json')}>Download treatment</button><button onClick={() => download('book2film-storyboard.svg', result.video.svg, 'image/svg+xml')}>Download SVG reel</button></div>
              <h3 className="treatment-title">{result.title}</h3><p className="logline">{result.logline}</p><p className="caution">Proposed adaptation. Page references are review locators, not proof of fidelity. Summarization is lossy; verify each beat against the source. Cards display abbreviated text. Full beats appear below.</p>
              {job.blank_pages?.length > 0 && <p className="caution">Pages with no extracted text: {job.blank_pages.join(', ')}. Check these before approval.</p>}
              <ol className="beats grid gap-4 sm:grid-cols-2">{result.scenes.map(scene => <li key={scene.scene_number}><span className="eyebrow accent">Beat {String(scene.scene_number).padStart(2, '0')}</span><p>{scene.description}</p><p className="adaptation-note">{scene.adaptation_notes}</p><div className="sources">Review source: {scene.source_pages.map(n => <button key={n} onClick={() => inspect(n)}>p. {n}</button>)}</div></li>)}</ol>
            </>}
            {page && <section className="source-page"><div className="flex justify-between gap-4"><h3>OCR / Page {page.page}</h3><button onClick={() => setPage(null)}>Close transcript</button></div><pre>{page.text}</pre></section>}
          </> : <div className="empty"><div className="empty-frame"><span>YOUR STORY, NEXT.</span></div><h3>The reel starts with your words.</h3><p>Upload, then run the saved checkpoints. Inspect the twelve beats before sharing anything.</p></div>}
        </div>
      </section>
    </main><footer><span>Book2Film / A MobleySoft venture</span><span>AuthFor &middot; Weyland OCR &middot; Qwen &middot; Filmline</span><span>Operator pilot. Not yet a public paid service.</span></footer>
  </div>;
}
