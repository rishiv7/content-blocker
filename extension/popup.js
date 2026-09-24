const $ = id => document.getElementById(id);
let tab, origin, settings, working = false, saving = false, draftDirty = false, refreshBusy = false, refreshRevision = 0, shortFormBusy = false;
const send = async m => { const r = await chrome.runtime.sendMessage(m); if (r.error) throw new Error(r.error); return r; };
function message(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
function updateCount() { $('count').textContent = `${$('instruction').value.length} / 2000`; }
function showRule(s) {
  $('active-summary').textContent = s.filterReady ? (s.filterSummary || 'Your filter is active.') : 'No active filter';
  $('active-instruction').textContent = s.instruction ? `Saved rule: ${s.instruction}` : 'Write a rule above to begin.';
  $('clear-rule').hidden = !s.instruction && !s.filterReady;
  if (!draftDirty && document.activeElement !== $('instruction')) { $('instruction').value = s.instruction || ''; updateCount(); }
  $('apply').disabled = saving || !$('instruction').value.trim();
}
async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  const version = refreshRevision;
  try {
    const s = await send({type: 'GET_SETTINGS'});
    if (version !== refreshRevision) return;
    settings = s; showRule(s);
    // Polling must not snap the checkbox back while its own save is in flight.
    if (!shortFormBusy) $('short-form').checked = !!s.shortForm;
    const enabled = !!origin && s.sites.includes(origin);
    // With short-form on, enabling a site needs no key and no rule — only permission.
    $('toggle').disabled = !origin || working || (!enabled && !s.shortForm && (!s.configured || !s.filterReady));
    $('toggle').setAttribute('aria-checked', String(enabled));
    $('status').classList.toggle('on', enabled);
    $('rescan').disabled = $('reveal').disabled = !enabled || working || !s.configured || !s.filterReady;
    let state;
    if (enabled) try { state = await chrome.tabs.sendMessage(tab.id, {type: 'STATUS'}); } catch {}
    if (version !== refreshRevision) return;
    $('covered').textContent = state?.covered || 0;
    $('checked').textContent = state?.checked || 0;
    // The text pipeline gates (key, filter) only name the missing prerequisite for
    // covers; short-form mode is deterministic and needs neither.
    const gate = !s.configured ? 'Add a TypeSafe key in Settings' : !s.filterReady ? 'Save a filter to start' : null;
    $('status').textContent = !origin ? 'Unavailable on this page' : !enabled ? (s.shortForm ? 'Off on this site' : gate || 'Off on this site') : gate ? (s.shortForm ? 'Blocking short-form video' : gate) : !state ? 'Refresh the page to start' : state.error ? 'Scan paused' : state.busy ? 'Checking with Jev…' : state.paused ? 'All text revealed' : state.limit ? 'New scan limit reached · cache active' : 'Filtering this site';
    if (state?.error) message('message', state.error, true);
  } finally { refreshBusy = false; }
}
$('instruction').addEventListener('input', () => { draftDirty = true; updateCount(); $('apply').disabled = saving || !$('instruction').value.trim(); });
$('apply').addEventListener('click', async () => {
  if (saving) return;
  const instruction = $('instruction').value.trim();
  if (!instruction) return;
  refreshRevision++;
  saving = true; $('apply').disabled = $('clear-rule').disabled = true; message('rule-message', 'Preparing your filter with TrueForge…');
  try {
    await send({type: 'SAVE_INSTRUCTION', instruction}); refreshRevision++;
    if ($('instruction').value.trim() === instruction) draftDirty = false;
    message('rule-message', 'Filter saved and applied.');
    await refresh();
  } catch (e) { message('rule-message', `Could not save: ${e.message}${settings?.filterReady ? ' Your previous filter is still active.' : ''}`, true); }
  finally { saving = false; $('clear-rule').disabled = false; $('apply').disabled = !$('instruction').value.trim(); }
});
$('clear-rule').addEventListener('click', async () => {
  if (saving) return;
  refreshRevision++;
  const draft = $('instruction').value;
  saving = true; $('clear-rule').disabled = $('apply').disabled = true; message('rule-message', 'Clearing filter…');
  try {
    await send({type: 'SAVE_INSTRUCTION', instruction: ''}); refreshRevision++;
    if ($('instruction').value === draft) { $('instruction').value = ''; draftDirty = false; updateCount(); }
    message('rule-message', 'Filter cleared everywhere.'); await refresh();
  }
  catch (e) { message('rule-message', e.message, true); }
  finally { saving = false; $('clear-rule').disabled = false; $('apply').disabled = !$('instruction').value.trim(); }
});
$('toggle').addEventListener('click', async () => {
  const enabled = !settings.sites.includes(origin);
  working = true; $('toggle').disabled = true; message('message', '');
  try {
    if (enabled) {
      const u = new URL(origin);
      const granted = await chrome.permissions.request({origins: [`${u.protocol}//${u.hostname}/*`]});
      if (!granted) throw new Error('Site access was not granted. Filtering stays off.');
    }
    await send({type: 'SET_SITE', origin, enabled, tabId: tab.id});
  } catch (e) { message('message', e.message, true); }
  finally { working = false; await refresh().catch(e => message('message', e.message, true)); }
});
$('short-form').addEventListener('change', async () => {
  if (shortFormBusy || !settings) return;
  shortFormBusy = true; $('short-form').disabled = true; message('message', '');
  try {
    // The threshold rides along because SAVE_SETTINGS validates it as one payload.
    await send({type: 'SAVE_SETTINGS', threshold: settings.threshold, shortForm: $('short-form').checked});
    await refresh();
  } catch (e) { $('short-form').checked = !!settings.shortForm; message('message', e.message, true); }
  finally { shortFormBusy = false; $('short-form').disabled = false; }
});
for (const [id, type] of [['rescan', 'RESCAN'], ['reveal', 'REVEAL_ALL']]) $(id).addEventListener('click', async () => {
  try { message('message', ''); await chrome.tabs.sendMessage(tab.id, {type}); await refresh(); }
  catch { message('message', 'Refresh this page to connect the extension.', true); }
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
try {
  [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab?.url) { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol) && u.hostname !== 'chromewebstore.google.com') { origin = u.origin; $('site').textContent = u.hostname; } }
  await refresh();
  setInterval(() => { refresh().catch(e => message('message', e.message, true)); }, 1000);
} catch (e) { message('message', e.message, true); }
