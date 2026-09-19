const $ = id => document.getElementById(id);
let tab, origin, settings, working = false;
const send = async m => { const r = await chrome.runtime.sendMessage(m); if (r.error) throw new Error(r.error); return r; };
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function refresh() {
  settings = await send({type: 'GET_SETTINGS'});
  const enabled = settings.sites.includes(origin);
  $('setup').hidden = settings.configured;
  $('controls').hidden = !settings.configured;
  $('toggle').disabled = !origin || !settings.configured || working;
  $('toggle').setAttribute('aria-checked', String(enabled));
  $('status').classList.toggle('on', enabled);
  $('rescan').disabled = $('reveal').disabled = !enabled || working;
  let state;
  if (enabled) try { state = await chrome.tabs.sendMessage(tab.id, {type: 'STATUS'}); } catch {}
  $('covered').textContent = state?.covered || 0;
  $('checked').textContent = state?.checked || 0;
  $('status').textContent = !origin ? 'Unavailable on this page' : !settings.configured ? 'Connect Jev to begin' : !enabled ? 'Off on this site' : !state ? 'Refresh the page to start' : state.error ? 'Scan paused' : state.busy ? 'Checking with Jev…' : state.paused ? 'All text revealed' : state.limit ? 'Page limit reached' : 'Filtering this site';
  if (state?.error) message(state.error, true);
}
$('toggle').addEventListener('click', async () => {
  const enabled = !settings.sites.includes(origin);
  working = true; $('toggle').disabled = true; message('');
  try {
    if (enabled) {
      const u = new URL(origin);
      const granted = await chrome.permissions.request({origins: [`${u.protocol}//${u.hostname}/*`]});
      if (!granted) throw new Error('Site access was not granted. Filtering stays off.');
    }
    await send({type: 'SET_SITE', origin, enabled, tabId: tab.id});
  } catch (e) { message(e.message, true); }
  finally { working = false; await refresh(); }
});
for (const [id, type] of [['rescan', 'RESCAN'], ['reveal', 'REVEAL_ALL']]) $(id).addEventListener('click', async () => {
  try { message(''); await chrome.tabs.sendMessage(tab.id, {type}); await refresh(); }
  catch { message('Refresh this page to connect the extension.', true); }
});
for (const id of ['settings', 'connect']) $(id).addEventListener('click', () => chrome.runtime.openOptionsPage());
try {
  [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab?.url) { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol) && u.hostname !== 'chromewebstore.google.com') { origin = u.origin; $('site').textContent = u.hostname; } }
  await refresh();
  setInterval(() => { if (!working) refresh().catch(() => {}); }, 1000);
} catch (e) { message(e.message, true); }
