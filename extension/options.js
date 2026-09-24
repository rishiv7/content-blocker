const $ = id => document.getElementById(id);
const send = async m => { const r = await chrome.runtime.sendMessage(m); if (r.error) throw new Error(r.error); return r; };
let saved, busy = false;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function setBusy(value) { busy = value; $('save').disabled = value; $('test').disabled = value || !saved?.configured || !saved?.filterReady; $('remove-key').disabled = $('test-compiler').disabled = value; }
async function load() {
  const s = await send({type: 'GET_SETTINGS'}); saved = s;
  $('threshold').value = Math.round(s.threshold * 100); $('value').value = $('threshold').value;
  $('key').placeholder = s.configured ? 'Key saved · leave blank to keep it' : 'Paste your TypeSafe API key';
  $('remove-key').hidden = !s.configured;
  $('test').disabled = busy || !s.configured || !s.filterReady;
  $('readiness').textContent = !s.filterReady ? 'Save a filter in the popup before enabling a site or testing Jev.' : !s.configured ? 'Add a TypeSafe key to check your saved filter on enabled sites.' : 'Ready to filter on enabled sites.';
  $('empty').hidden = !!s.sites.length; $('sites').replaceChildren();
  for (const origin of s.sites) {
    const li = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
    label.textContent = origin; button.textContent = 'Turn off'; button.className = 'text-button'; button.type = 'button';
    button.addEventListener('click', async () => { try { await send({type: 'SET_SITE', origin, enabled: false}); await load(); } catch (e) { message(e.message, true); } });
    li.append(label, button); $('sites').append(li);
  }
}
$('threshold').addEventListener('input', () => $('value').value = $('threshold').value);
for (const [field, control, label] of [['key', 'show-key', 'TypeSafe API key']]) {
  $(control).addEventListener('click', () => { const show = $(field).type === 'password'; $(field).type = show ? 'text' : 'password'; $(control).textContent = show ? 'Hide' : 'Show'; $(control).setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${label}`); });
}
$('form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; setBusy(true); message('Saving settings…');
  try {
    const key = $('key').value.trim();
    await send({type: 'SAVE_SETTINGS', threshold: Number($('threshold').value) / 100, ...(key ? {apiKey: key} : {})});
    $('key').value = ''; await load(); message('Settings saved. Write or update your filter in the popup.');
  } catch (e) { message(e.message, true); } finally { setBusy(false); }
});
$('test').addEventListener('click', async () => {
  if (busy || !saved?.configured || !saved?.filterReady) return;
  setBusy(true); message('Testing your saved filter with Jev…');
  try { await send({type: 'TEST'}); message('Jev is ready to check your saved filter.'); }
  catch (e) { message(e.message, true); } finally { setBusy(false); }
});
for (const [control, field, property, label] of [['remove-key', 'key', 'apiKey', 'TypeSafe']]) {
  $(control).addEventListener('click', async () => {
    if (busy) return; setBusy(true); message(`Removing ${label} key…`);
    try { await send({type: 'SAVE_SETTINGS', threshold: Number($('threshold').value) / 100, [property]: ''}); $(field).value = ''; await load(); message(`${label} key removed.`); }
    catch (e) { message(e.message, true); } finally { setBusy(false); }
  });
}
$('test-compiler').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); $('compiler-status').textContent = 'Connecting to TrueForge…';
  try {
    const result = await send({type: 'TEST_COMPILER'});
    $('compiler-status').textContent = `Connected · ${result.model}`;
  } catch (e) { $('compiler-status').textContent = e.message; }
  finally { setBusy(false); }
});
load().catch(e => message(e.message, true));
