// The service worker. It puts the What's new dot on the Badger button after an
// update, and marks the toolbar icon OFF while the popup's switch is off.

// ─── the toolbar switch ──────────────────────────────────────────────────────
// popup.html sets chrome.storage.local.badgerOff. While it is on, the icon
// dims and wears an OFF badge, so Fantasy Badger is never off without its
// owner seeing it; the league pages read the same key before they draw.
// The icon keeps its colour when off — dimmed, not greyed — so it is still
// recognisably the badger. Both states are drawn here from the manifest's
// icon: handing Chrome the path left the off icon standing after switching on.
async function toolbarIcons(off) {
    const m = chrome.runtime.getManifest(), path = (m.action && m.action.default_icon && (m.action.default_icon['48'] || m.action.default_icon['16'])) || 'icons/badger-icon.png';
    const bmp = await createImageBitmap(await (await fetch(chrome.runtime.getURL(path))).blob());
    const out = {};
    for (const sz of [16, 32]) {
        const c = new OffscreenCanvas(sz, sz), g = c.getContext('2d');
        g.imageSmoothingQuality = 'high'; if (off) g.globalAlpha = 0.6;
        g.drawImage(bmp, 0, 0, sz, sz); out[sz] = g.getImageData(0, 0, sz, sz);
    }
    return out;
}
async function drawSwitch() {
    let off = false; try { off = !!(await chrome.storage.local.get('badgerOff')).badgerOff; } catch (e) { /* treat as on */ }
    // each on its own: a failed icon must not leave the badge or the title stale
    try { await chrome.action.setBadgeText({ text: off ? 'OFF' : '' }); if (off) await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' }); } catch (e) { /* the badge is a courtesy */ }
    try { await chrome.action.setTitle({ title: off ? 'Fantasy Badger — off on Sleeper' : 'Fantasy Badger' }); } catch (e) { /* so is the title */ }
    try { await chrome.action.setIcon({ imageData: await toolbarIcons(off) }); } catch (e) { console.warn('[Fantasy Badger] toolbar icon', e); }
}
// One at a time, in the order asked: each run reads the switch afresh, so a
// quick off-and-on ends on the icon for where the switch came to rest.
let switchQueue = Promise.resolve();
function showSwitch() { switchQueue = switchQueue.then(drawSwitch, drawSwitch); return switchQueue; }
chrome.runtime.onStartup.addListener(showSwitch);
chrome.runtime.onInstalled.addListener(showSwitch);
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && 'badgerOff' in ch) showSwitch(); });

// What's new: an update that brings notes newer than the version you had puts
// a dot on the Badger button until they are opened. The version is the date and
// the time of day, and the notes are keyed by the date, so "newer" is a plain
// comparison of the first three numbers. A fresh install shows none: the store
// listing already did the introducing. An update with nothing new to say
// shows none either.
try { importScripts('changelog.js'); } catch (e) { /* no notes: no dot */ }
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'update' || !details.previousVersion) return;
    const day = (v) => String(v).split('.').slice(0, 3).map(Number);
    const later = (a, b) => { const x = day(a), y = day(b); return (x[0] - y[0] || (x[1] || 0) - (y[1] || 0) || (x[2] || 0) - (y[2] || 0)) > 0; };
    const top = (globalThis.BADGER_NOTES || [])[0], now = chrome.runtime.getManifest().version;
    if (top && later(top.v, details.previousVersion) && !later(top.v, now)) chrome.storage.local.set({ badgerNotesUnread: top.v });
});
