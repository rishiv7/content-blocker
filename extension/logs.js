const $ = id => document.getElementById(id);
const send = async m => {const r = await chrome.runtime.sendMessage(m); if (r.error) throw new Error(r.error); return r;};
let entries = [], selected = null, lastSnapshot = '', loading = false;
const labels = {api: 'Jev API', cache: 'Cache hit', shared: 'Shared request'};
const pretty = value => JSON.stringify(value, null, 2);
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function showDetail() {
 const e = entries.find(x => x.id === selected);
 $('choose').hidden = !!e; $('detail').hidden = !e; if (!e) return;
 $('event-title').textContent = labels[e.kind] || e.kind;
 $('event-status').textContent = e.state.toUpperCase();
 $('event-meta').textContent = `${new Date(e.startedAt).toLocaleString()} · ${e.origin || 'Extension'} · ${e.durationMs ?? '…'} ms${e.score != null ? ` · Score ${Math.round(e.score * 100)}/100` : ''}`;
 $('event-note').textContent = e.kind === 'cache' ? 'Reused a saved score. No API request was sent.' : e.kind === 'shared' ? 'Reused an evaluation already in progress. No additional API request was sent.' : e.response?.truncated ? 'Response preview truncated at 16 KB.' : 'Request and response bodies from the Jev API. Authorization is never recorded.';
 $('event-error').textContent = e.error || '';
 $('passage').textContent = e.passage;
 $('request').textContent = e.request ? pretty(e.request) : 'No request sent.';
 if (e.response) {
   let body = e.response.body; try {body = JSON.parse(body);} catch {}
   $('response').textContent = pretty({httpStatus: e.response.status, body, ...(e.response.truncated ? {truncated: true} : {})});
 } else $('response').textContent = e.kind === 'api' ? e.state === 'pending' ? 'Waiting for Jev…' : 'No HTTP response received.' : pretty({cachedScore: e.score});
 $('hash').textContent = e.passageHash ? `Passage fingerprint: ${e.passageHash}` : '';
}
function render() {
 const filter = $('filter').value;
 const visible = [...entries].reverse().filter(e => filter === 'all' || (filter === 'error' ? e.state === 'error' : e.kind === filter));
 if (!visible.some(e => e.id === selected)) selected = visible[0]?.id || null;
 $('count').textContent = `${visible.length} event${visible.length === 1 ? '' : 's'}`;
 $('events').replaceChildren(); $('empty').hidden = !!visible.length;
 for (const e of visible) {
   const button = document.createElement('button'); button.className = 'event'; button.type = 'button'; button.dataset.error = String(e.state === 'error'); button.setAttribute('aria-pressed', String(selected === e.id));
   const top = document.createElement('div'); top.className = 'event-top';
   const label = document.createElement('span'); label.textContent = labels[e.kind];
   const time = document.createElement('span'); time.textContent = new Date(e.startedAt).toLocaleTimeString(); top.append(label, time);
   const snippet = document.createElement('div'); snippet.className = 'event-snippet'; snippet.textContent = e.passage;
   const bottom = document.createElement('div'); bottom.className = 'event-bottom';
   const state = document.createElement('span'); state.textContent = `${e.state}${e.response ? ` · HTTP ${e.response.status}` : ''}`;
   const score = document.createElement('span'); score.textContent = e.score == null ? '…' : `${Math.round(e.score * 100)}/100`; bottom.append(state, score);
   button.append(top, snippet, bottom); button.addEventListener('click', () => {selected = e.id; render();}); $('events').append(button);
 }
 showDetail();
}
async function refresh() {
 if (loading) return; loading = true;
 try {
   const result = await send({type: 'GET_LOGS'}); const snapshot = JSON.stringify(result);
   $('record').checked = result.enabled; $('live').textContent = result.enabled ? 'LIVE' : 'RECORDING PAUSED';
   if (snapshot !== lastSnapshot) {entries = result.entries; lastSnapshot = snapshot; render();}
 } catch (e) {message(e.message, true);} finally {loading = false;}
}
$('filter').addEventListener('change', render);
$('record').addEventListener('change', async () => {try {await send({type: 'SET_LOGGING', enabled: $('record').checked}); await refresh();} catch (e) {message(e.message, true);}});
$('clear').addEventListener('click', async () => {try {await send({type: 'CLEAR_LOGS'}); await refresh(); message('Log cleared. Saved classification scores are unchanged.');} catch (e) {message(e.message, true);}});
$('export').addEventListener('click', () => {
 const blob = new Blob([pretty({exportedAt: new Date().toISOString(), entries})], {type: 'application/json'});
 const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'slop-shield-request-log.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
refresh(); setInterval(refresh, 1000);
