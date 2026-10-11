// The toolbar popup: Fantasy Badger on or off, on Sleeper. Off means it does not
// run there at all — Sleeper's own pages, untouched — until it is switched back
// on. The setting is chrome.storage.local.badgerOff; the league pages read it
// before they draw anything, and the service worker marks the toolbar icon OFF.
// Switching reloads any open Sleeper league tab, so the change shows at once.
'use strict';
const KEY = 'badgerOff';
const m = chrome.runtime.getManifest();
// the icon the toolbar shows
document.getElementById('icon').src = chrome.runtime.getURL((m.action && m.action.default_icon && (m.action.default_icon['48'] || m.action.default_icon['16'])) || 'icons/badger-icon.png');
document.getElementById('ver').textContent = (m.version_name || m.version).split('.').slice(0, 3).join('.');   // the date, without the time of day
const sw = document.getElementById('sw');

function show(off) {
    sw.setAttribute('aria-checked', String(!off));
    document.getElementById('state').textContent = off ? 'OFF' : 'ON';
    document.getElementById('say').textContent = off
        ? 'Off: Sleeper’s own pages, untouched. Turn it on to come back.'
        : 'Your league pages open in Fantasy Badger.';
}
chrome.storage.local.get(KEY).then((st) => show(!!(st && st[KEY])), () => show(false));

sw.addEventListener('click', async () => {
    const off = sw.getAttribute('aria-checked') === 'true';   // it was on: switching turns it off
    show(off);
    try { await chrome.storage.local.set({ [KEY]: off }); } catch (e) { show(!off); return; }
    // any Sleeper league tab redraws as the switch now says
    try {
        const tabs = await chrome.tabs.query({ url: ['https://sleeper.com/leagues/*'] });
        for (const t of tabs) chrome.tabs.reload(t.id);
    } catch (e) { /* no tab to reload */ }
});
