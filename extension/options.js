const $ = id => document.getElementById(id);
const send = async m => { const r = await chrome.runtime.sendMessage(m); if (r.error) throw new Error(r.error); return r; };
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function load() {
  const s = await send({type: 'GET_SETTINGS'});
  $('threshold').value = Math.round(s.threshold * 100); $('value').value = $('threshold').value;
  $('key').placeholder = s.configured ? 'Key saved · leave blank to keep it' : 'Paste your API key';
  $('remove-key').hidden = !s.configured; $('test').disabled = !s.configured;
  $('empty').hidden = !!s.sites.length; $('sites').replaceChildren();
  for (const origin of s.sites) {
    const li = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
    label.textContent = origin; button.textContent = 'Turn off'; button.className = 'text-button'; button.type = 'button';
    button.addEventListener('click', async () => { try { await send({type: 'SET_SITE', origin, enabled: false}); await load(); } catch (e) { message(e.message, true); } });
    li.append(label, button); $('sites').append(li);
  }
}
$('threshold').addEventListener('input', () => $('value').value = $('threshold').value);
$('show-key').addEventListener('click', () => { const show = $('key').type === 'password'; $('key').type = show ? 'text' : 'password'; $('show-key').textContent = show ? 'Hide' : 'Show'; $('show-key').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key'); });
$('form').addEventListener('submit', async event => {
  event.preventDefault(); $('save').disabled = true;
  try {
    const key = $('key').value.trim();
    await send({type: 'SAVE_SETTINGS', threshold: Number($('threshold').value) / 100, ...(key ? {apiKey: key} : {})});
    $('key').value = ''; await load(); message('Saved. Open Slop Shield on a website to enable filtering.');
  } catch (e) { message(e.message, true); } finally { $('save').disabled = false; }
});
$('test').addEventListener('click', async () => {
  $('test').disabled = true; message('Checking Jev with a short sample passage…');
  try { await send({type: 'TEST'}); message('Connected. Jev is ready to clear some space.'); }
  catch (e) { message(e.message, true); } finally { $('test').disabled = false; }
});
$('remove-key').addEventListener('click', async () => {
  try { await send({type: 'SAVE_SETTINGS', apiKey: '', threshold: Number($('threshold').value) / 100}); await load(); message('Key removed. Filtering has stopped.'); }
  catch (e) { message(e.message, true); }
});
load().catch(e => message(e.message, true));
