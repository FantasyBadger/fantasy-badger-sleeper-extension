// Fantasy Badger — sleeper.com league pages, rebuilt.
//
// Replaces the shell of /leagues/<id>/* (sidebar, chat rail, seven-tab strip)
// with a cockpit Home and four pages: Team, Players, Scoreboard, League. Chat
// is a drawer. Every score, roster, box score and play on these pages comes from
// Sleeper — its REST endpoints, the GraphQL operations its own site uses and
// the socket it renders from, with your session — and every action posts
// through those same operations. The session
// token never leaves the browser.
//
// Escape hatch: the "Sleeper original" button (top right) turns this off and
// reloads; a small pill on Sleeper's own page turns it back on. Any render
// error also falls back to the original page and says so.
(() => {
'use strict';
if (window.__badgerLeagueBooted) return;
window.__badgerLeagueBooted = true;

const TAG = '[BADGER]-[league]';
console.info('[BADGER]-[league] script parsed, booting on', location.pathname);   // boot canary: if this never prints, the script died before running
const API = 'https://api.sleeper.app/v1';
const API2 = 'https://api.sleeper.com';
const GQL = 'https://sleeper.com/graphql';
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const FLEX = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], IDP_FLEX: ['DL', 'LB', 'DB'] };
// A slot chip. Fixed slots wear their position's colour; a flex slot wears a
// blend of every position it will take, so the chip says what it accepts
// without spelling it out.
// A team defence is DST on every badge and label (its NAME reads "PIT D/ST").
const posLabel = (p) => p === 'DEF' ? 'DST' : (p || '');
const slotLabel = (sl) => FLEX[sl] ? (sl === 'FLEX' ? 'FLEX' : sl.replace('_FLEX', '').replace('SUPER', 'SF')) : posLabel(sl);
// A flex slot keeps its blended colour, but says who is IN it: the position of
// the player occupying it, or both when the two sides of a matchup differ
// ("RB·WR"). Empty, it still says FLEX.
function slotChip(sl, cls, occupants) {
    const elig = FLEX[sl];
    if (!elig) return h('span', { class: `pos ${sl}${cls ? ' ' + cls : ''}` }, posLabel(sl));
    const n = elig.length, W = 16;   // how wide each colour boundary blends
    const stops = elig.map((pos, i) => {
        const v = `var(--${pos.toLowerCase()}, var(--def))`;
        const a = i === 0 ? 0 : (i / n) * 100 + W / 2, b = i === n - 1 ? 100 : ((i + 1) / n) * 100 - W / 2;
        return `${v} ${a.toFixed(1)}%, ${v} ${b.toFixed(1)}%`;
    }).join(', ');
    const occ = (occupants || []).filter(pid => pid && pid !== '0');
    const held = [...new Set(occ.map(pid => posLabel(ppos(pid))).filter(Boolean))];
    const title = `${slotLabel(sl)} (${elig.map(posLabel).join('/')})${occ.length ? ` \u2014 ${occ.map(pid => `${pname(pid)} ${posLabel(ppos(pid))}`).join(', ')}` : ''}`;
    return h('span', { class: `pos flexc${held.length > 1 ? ' two' : ''}${cls ? ' ' + cls : ''}`, title, style: `background: linear-gradient(100deg, ${stops})` }, held.length ? held.join('\u00b7') : slotLabel(sl));
}
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SVG_NS = 'http://www.w3.org/2000/svg';

// ── state ────────────────────────────────────────────────────────────────────
const S = {
    leagueId: null, page: 'home', week: 1, curWeek: 1, season: null, seasonType: 'regular',
    league: null, rosters: [], users: [], players: null, state: null,
    proj: {}, stats: {}, matchups: {}, legs: {}, plays: {}, wpHist: {}, ledger: {}, ledgerAll: {}, txns: {}, research: null, schedule: null, trending: null,
    news: {}, pending: [], messages: [], myUserId: null, myRoster: null,
    seasonProj: null, seasonStats: null, msgBusy: false, dms: null, dmMsgs: {}, dmBusy: false, chatRead: {}, chatPins: {}, chatOlder: {}, chatPending: {}, txnStatus: {}, sheet: null, sheetReady: false, sheetBusy: false,
    ui: { playersTab: 'available', playersPos: 'ALL', playersTeam: '', playersSort: { f: 'proj', d: 'desc' }, playersQ: '', playersInjured: false, playersTrending: false, playersHideBye: false, playersNflFa: false, basis: 'wkProj', scope: 'weekly', teamSort: null, chat: false, homeTab: 'matchup', composer: null, sel: null, menu: false, swapFrom: null, muView: 'one', muPick: false },
    loading: new Set(), errors: [],
};
let root, shadow, app, layer, toastTimer;

// ── small utils ──────────────────────────────────────────────────────────────
const $ = (sel, el) => (el || shadow).querySelector(sel);
const $$ = (sel, el) => Array.from((el || shadow).querySelectorAll(sel));
const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return el;
};
// The caret on anything that opens a menu: drawn (league.css i.car), the same
// size on every control. The ▾ character is not in the bundled faces, and the
// fallback drew it as a speck. Pointing up while its menu is open, where asked.
const caret = (cls, up) => h('i', { class: `car${cls ? ' ' + cls : ''}${up ? ' up' : ''}`, 'aria-hidden': 'true' });
// The same caret on what folds open in place: pointing right while folded, down once open.
const foldCaret = (open, cls) => h('i', { class: `car fold${open ? ' open' : ''}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
const fmt1 = (n) => (n == null || !isFinite(n)) ? '—' : (Math.round(n * 10) / 10).toFixed(1);
const fmt0 = (n) => (n == null || !isFinite(n)) ? '—' : String(Math.round(n));
// a SCORE: two places, because a passing yard is worth 0.04 here and tenths hide it
const fmtS = (n) => (n == null || !isFinite(n)) ? '—' : (Math.round(n * 100) / 100).toFixed(2);
const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); if (s < 60) return 'now'; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`; };
const initials = (name) => String(name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const avatarUrl = (a) => a ? `https://sleepercdn.com/avatars/thumbs/${a}` : null;
const headshot = (pid) => /^[A-Z]{2,3}$/.test(pid) ? `https://sleepercdn.com/images/team_logos/nfl/${pid.toLowerCase()}.png` : `https://sleepercdn.com/content/nfl/players/thumb/${pid}.jpg`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toast(text, kind) {
    const old = $('.toast'); if (old) old.remove();
    const t = h('div', { class: `toast ${kind || ''}` }, text);
    layer.appendChild(t);   // outside app: render() wipes app, and a toast must outlive the repaint it announces
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}
function readToken() { try { return localStorage.getItem('token'); } catch (e) { return null; } }

// ── copy a card as a picture ─────────────────────────────────────────────────
// Every card with a title row carries a copy button; one click puts a picture
// of the card on the clipboard, as it is on screen (a scrolled list copies the
// rows you are looking at), with a line under it saying whose league and when.
// The picture is drawn by the browser itself: the card's own markup, this
// stylesheet and the bundled faces inside an SVG, painted onto a canvas at twice
// screen size. Images ride along as data, so nothing outside Sleeper is asked;
// Sleeper's image server allows the read.
const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.2" y="5.2" width="8.6" height="8.6" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.6 3.4V3a1.6 1.6 0 0 0-1.6-1.6H3A1.6 1.6 0 0 0 1.4 3v6A1.6 1.6 0 0 0 3 10.6h.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let copyCss = null, copyFaces = null;
const copyImgs = new Map();   // url → data URL, for the session: headshots repeat across cards
const asDataUrl = (blob) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(blob); });
async function fetchDataUrl(u) {
    if (copyImgs.has(u)) return copyImgs.get(u);
    // no-store: the page's own <img> request was not a CORS one, and a cached copy
    // of it answers this one without the header that allows the read
    const p = fetch(u, { mode: 'cors', cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); }).then(asDataUrl);
    copyImgs.set(u, p); p.catch(() => copyImgs.delete(u));
    return p;
}
// Inside the picture, the browser takes the picture's own size for the screen's:
// a 725px card would switch to the phone layout, and 70vh would mean 70% of the
// picture. So the copy gets the stylesheet as this window reads it: each @media
// block kept or dropped by the real window, viewport units turned into pixels.
function cssAsSeen(css) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let out = '', i = 0;
    for (;;) {
        const j = css.indexOf('@media', i); if (j < 0) { out += css.slice(i); break; }
        out += css.slice(i, j);
        const open = css.indexOf('{', j); if (open < 0) break;
        let depth = 1, k = open + 1; for (; k < css.length && depth; k++) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; }
        let on = false; try { on = matchMedia(css.slice(j + 6, open).trim()).matches; } catch (e) { /* a query this browser cannot read applies nowhere */ }
        if (on) out += css.slice(open + 1, k - 1);
        i = k;
    }
    return out.replace(/(\d*\.?\d+)(?:d|s|l)?v(h|w)\b/g, (m, n, u) => `${Math.round(parseFloat(n) * (u === 'h' ? innerHeight : innerWidth)) / 100}px`);
}
function copyStamp() {
    const name = (S.league && S.league.name) || 'Sleeper';
    const now = S.week === S.curWeek ? ` · as of ${new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
    return `${name} · Week ${S.week}${now}`;
}
async function cardPicture(card) {
    if (!copyCss) copyCss = fetch(chrome.runtime.getURL('league.css')).then((r) => r.text());
    if (!copyFaces) copyFaces = Promise.all(FONT_FACES.map(async ([fam, w, file, range]) => `@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};src:url(${await fetchDataUrl(chrome.runtime.getURL('fonts/' + file))}) format('woff2');unicode-range:${range}}`)).then((a) => a.join('\n'));
    const rect = card.getBoundingClientRect(), W = Math.ceil(rect.width), H = Math.ceil(rect.height);
    const clone = card.cloneNode(true);
    const from = [card, ...card.querySelectorAll('*')], to = [clone, ...clone.querySelectorAll('*')];
    const pending = [];
    for (let i = 0; i < from.length; i++) {
        const a = from[i], b = to[i];
        // as seen: a scrolled box keeps its place, its children shifted by the scroll
        if (a.scrollTop || a.scrollLeft) {
            b.style.overflow = 'hidden';
            [...a.children].forEach((ch, j) => { const cs = getComputedStyle(ch), bc = b.children[j]; if (!bc || cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky') return;
                if (cs.position === 'static') bc.style.position = 'relative';
                bc.style.top = `${(parseFloat(cs.top) || 0) - a.scrollTop}px`; bc.style.left = `${(parseFloat(cs.left) || 0) - a.scrollLeft}px`; });
        }
        if (a.tagName === 'IMG') { const u = a.currentSrc || a.src; b.removeAttribute('srcset'); if (u && !u.startsWith('data:')) pending.push(fetchDataUrl(u).then((d) => b.setAttribute('src', d), () => { b.removeAttribute('src'); b.style.visibility = 'hidden'; })); }
        else if (a.tagName === 'CANVAS') { try { const im = document.createElement('img'); im.src = a.toDataURL(); im.style.cssText = `width:${a.clientWidth}px;height:${a.clientHeight}px`; b.replaceWith(im); } catch (e) { /* a tainted canvas stays blank */ } }
    }
    for (const x of clone.querySelectorAll('.cpy')) x.remove();
    clone.style.width = W + 'px'; clone.style.height = H + 'px'; clone.style.margin = '0';
    // the card's ancestors keep their classes, so every selector still matches, but
    // draw no box. Read now: a live re-render can take the card off the page mid-copy.
    let wrap = clone;
    for (let a = card.parentElement; a && a !== app && a.parentNode; a = a.parentElement) { const sh = document.createElement(a.tagName.toLowerCase()); sh.className = a.className; sh.style.display = 'contents'; sh.append(wrap); wrap = sh; }
    const stamp = copyStamp();
    const [cssText, faces] = await Promise.all([copyCss, copyFaces, ...pending]), css = cssAsSeen(cssText);
    const PAD = 14, FOOT = 34;
    const frame = h('div', { class: 'bl', style: `display:block;width:${W + PAD * 2}px;height:${H + PAD + FOOT}px;padding:${PAD}px ${PAD}px 0;min-height:0;box-sizing:border-box;background:var(--bg);overflow:hidden` },
        wrap, h('div', { style: `display:flex;align-items:center;justify-content:space-between;gap:12px;height:${FOOT}px;font:600 12px var(--mono);color:var(--ink-3);white-space:nowrap` },
            h('span', null, stamp), h('span', null, 'Fantasy Badger')));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W + PAD * 2}" height="${H + PAD + FOOT}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA[${faces}\n${css}]]></style>${new XMLSerializer().serializeToString(frame)}</div></foreignObject></svg>`;
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode(); await new Promise((r) => setTimeout(r, 60));   // the faces settle a beat after decode
    const cv = document.createElement('canvas'); cv.width = (W + PAD * 2) * 2; cv.height = (H + PAD + FOOT) * 2;
    const g = cv.getContext('2d'); g.scale(2, 2); g.drawImage(img, 0, 0);
    return new Promise((res, rej) => cv.toBlob((b) => b ? res(b) : rej(new Error('the picture came out empty')), 'image/png'));
}
async function copyCard(card, btn) {
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    const title = ((card.querySelector('.card-h h3') || {}).textContent || 'card').trim();
    const pic = cardPicture(card);
    try {
        // handed the promise straight away: the click's permission to write the clipboard does not outlast a long wait
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pic })]);
        btn.innerHTML = COPIED_ICON; btn.classList.add('done');
        toast(`Copied ${title === 'card' ? 'the card' : title} as a picture. Paste it anywhere.`, 'ok');
        setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('done'); }, 1600);
    } catch (e) {
        try {
            const blob = await pic, a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = `fantasy-badger-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'card'}.png`;
            document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            toast('The clipboard was closed to the page, so the picture is in your Downloads.', 'ok');
        } catch (e2) { console.warn(TAG, 'copy card:', e2 && e2.message); toast(`Could not make the picture: ${(e2 && e2.message) || e2}`, 'err'); }
    } finally { btn.classList.remove('busy'); }
}
function copyButton(card) {
    const btn = h('button', { class: 'cpy', type: 'button', title: 'Copy this card as a picture', 'aria-label': 'Copy this card as a picture', html: COPY_ICON });
    btn.addEventListener('click', (e) => { e.stopPropagation(); copyCard(card, btn); });
    return btn;
}
// After each render: a button on every card of the page with a title row, and on
// the matchup's two cards, which have none: always in the card's top-right
// corner, the same spot on every card. The card keeps that corner clear: its
// title row, or for the two matchup cards its whole content, stops short of it.
function addCopyButtons(page) {
    for (const card of page.querySelectorAll('.card')) {
        if (card.parentElement.closest('.card') || card.querySelector(':scope > .cpy')) continue;
        if (!card.querySelector(':scope > .card-h') && !card.classList.contains('mscard') && !card.classList.contains('mwpcard')) continue;
        card.classList.add('cpyc');
        card.append(copyButton(card));
    }
}
function resolveMyUserId() {
    try {
        const token = readToken();
        if (!token) return null;
        const b64url = token.split('.')[1];
        const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - b64url.length % 4) % 4);
        const raw = atob(b64);
        // Never JSON.parse the id: 64-bit, loses precision past 2^53.
        const m = raw.match(/"(?:user_id|sub|id)"\s*:\s*"?(\d+)"?/);
        return m ? m[1] : null;
    } catch (e) { return null; }
}

// ── transport ────────────────────────────────────────────────────────────────
// A read that dies on the wire ("Failed to fetch": no answer at all, as when the
// laptop wakes and the old connection to Sleeper is gone) is sent once more a
// moment later, on a fresh connection. Reads only: a write whose answer was lost
// may still have landed, so it is never sent twice. Offline, nothing is retried.
const READ_RETRY_MS = 1500;
async function fetchRead(url, opts) {
    try { return await fetch(url, opts); }
    catch (e) {
        if (!(e instanceof TypeError) || !navigator.onLine) throw e;
        await new Promise((res) => setTimeout(res, READ_RETRY_MS));
        return fetch(url, opts);
    }
}
async function rest(url) {
    // Sleeper's CDN serves a ~30s-stale copy of every REST URL; a fresh query
    // string is the only reliable way past it.
    const r = await fetchRead(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
}
async function gql(operationName, query, variables) {
    const token = readToken();
    if (!token) throw new Error('Not signed in');
    const send = /^\s*query\b/.test(query) ? fetchRead : fetch;   // a query may be re-sent; a mutation never
    const r = await send(GQL, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': token }, body: JSON.stringify({ operationName, variables: variables || {}, query }) });
    const j = await r.json();
    if (j.errors && j.errors.length) throw new Error(j.errors.map(e => e.message).join('; '));
    return j.data;
}
const kv = (obj) => { const keys = Object.keys(obj || {}); return { keys, values: keys.map(k => obj[k]) }; };
const gqlList = (arr) => JSON.stringify(arr);

// ── player DB cache (IndexedDB, 12h) ─────────────────────────────────────────
function idb() {
    return new Promise((res, rej) => {
        const q = indexedDB.open('badger-league', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('kv');
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
}
async function idbGet(k) { try { const db = await idb(); return await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); } catch (e) { return null; } }
async function idbSet(k, v) { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = res; t.onerror = () => rej(t.error); }); } catch (e) { /* no cache, no drama */ } }
async function loadPlayers(force) {
    const c = await idbGet('players');
    // Injury designations move on Sundays and Mondays; a 12h cache is too slow
    // to catch a Questionable flipping to Out an hour before kickoff.
    const gameDay = [0, 1].includes(new Date().getDay());
    const ttl = (gameDay ? 1 : 12) * 3600e3;
    if (!force && c && c.at && Date.now() - c.at < ttl && c.data) { S.players = c.data; S.playersAt = c.at; return; }
    const data = await rest(`${API}/players/nfl`);
    S.players = data; S.playersAt = Date.now();
    idbSet('players', { at: S.playersAt, data });
}
// A designation is as fresh as the last thing Sleeper sent about the player.
// The player list above is read when the page opens, an hour old at most; the
// week's stat and projection rows each carry the player as he stands now. So a
// starter ruled out during his game kept the chip he kicked off with until the
// page was reloaded. Each row that arrives brings his standing with it.
const STANDING = ['injury_status', 'injury_body_part', 'injury_notes', 'injury_start_date', 'news_updated'];
function foldStanding(pid, now) {
    const pl = S.players && S.players[pid];
    if (!pl || !now || !('injury_status' in now)) return false;
    if (now.news_updated && pl.news_updated && now.news_updated < pl.news_updated) return false;   // the list already knows something later
    const moved = (pl.injury_status || null) !== (now.injury_status || null) || (pl.injury_body_part || null) !== (now.injury_body_part || null);
    for (const k of STANDING) if (k in now) pl[k] = now[k];
    return moved;   // true when the designation itself changed
}
// That covers a player once he has a stat line. One who has none yet (his game
// is still to come, or he was ruled out before it) would keep an old chip for
// as long as the tab stays open. The week's projection rows carry everyone's
// standing at a tenth of the player list's size on the wire, so they are read
// again every ten minutes while a game of the current week kicks off within
// three hours, and hourly otherwise. Only the standing is taken from them: the
// projections on screen stay the ones the session loaded, which a player's
// kickoff projection depends on.
let standingsAt = 0;   // the last time the current week's rows were read
const kickoffNear = () => {
    const m = (S.kickByWeek || {})[S.curWeek] || {}, now = Date.now();
    for (const t in m) { const g = m[t], at = g ? Date.parse(g.t) : NaN; if (g && !g.started && at - now < 3 * 3600e3 && at - now > -900e3) return true; }
    return false;
};
const standingsDue = () => S.seasonType === 'regular' && !!S.players && !!S.league && Date.now() - standingsAt >= (kickoffNear() ? 600e3 : 3600e3);
async function refreshStandings() {
    standingsAt = Date.now();
    const list = await rest(weekProjUrl(S.curWeek)).catch(() => null);
    if (!Array.isArray(list)) return false;
    let moved = false;
    for (const x of list) if (foldStanding(String(x.player_id), x.player)) moved = true;
    return moved;
}
const P = (pid) => (S.players && S.players[pid]) || (/^[A-Z]{2,3}$/.test(pid) ? { player_id: pid, position: 'DEF', team: pid, first_name: pid, last_name: 'D/ST', full_name: `${pid} D/ST`, fantasy_positions: ['DEF'] } : null);
const pname = (pid) => { const p = P(pid); return p ? (p.position === 'DEF' ? `${p.team || pid} D/ST` : `${p.first_name || ''} ${p.last_name || ''}`.trim()) : pid; };
const ppos = (pid) => { const p = P(pid); return p ? p.position : '?'; };

// ── scoring, projections ─────────────────────────────────────────────────────
function scoreStats(stats) {
    if (!stats || !S.league) return null;
    const sc = S.league.scoring_settings || {};
    let pts = 0, any = false;
    for (const [k, w] of Object.entries(sc)) { if (stats[k] != null && typeof w === 'number') { pts += stats[k] * w; any = true; } }
    if (any) return pts;
    // Nothing the league scores — but if he suited up (a target, a snap, a game
    // played), that is a score of zero, not a missing line. Sleeper omits its
    // own pts_* when they are 0, so falling through to null drew a dash for a
    // tight end who ran 38 routes and caught nothing.
    return stats.pts_half_ppr ?? stats.pts_ppr ?? stats.pts_std ?? ((stats.gp > 0 || stats.off_snp > 0) ? 0 : null);
}
const weekProjUrl = (week) => `${API2}/projections/nfl/${S.season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_half_ppr`;
async function loadProj(week) {
    if (S.proj[week]) return;
    // Nothing can be scored before the league's scoring settings are in hand —
    // scoreStats returns null without them, and this map is baked once and read
    // all session. Fetching now would cache a league that scores nothing.
    if (!S.league) return;
    const list = await rest(weekProjUrl(week));
    const m = {};
    for (const x of list) m[x.player_id] = { pts: scoreStats(x.stats), opp: x.opponent, game: x.game_id, team: x.team, stats: x.stats };
    if (week === S.curWeek) { for (const x of list) foldStanding(String(x.player_id), x.player); standingsAt = Date.now(); }
    // An unscored answer is not an answer. scoreStats returns null until the
    // league's scoring settings are in hand, and fourteen of these go out at
    // once when the season sim warms up — so a week fetched a beat too early
    // used to be cached, permanently, as "nobody scores anything". That is how
    // a playoff card came to be priced off a league worth six points a week.
    // Let those retry; give up after a few tries so a week that genuinely has
    // no projections stops asking.
    // Never cache an unscored map: better to ask again than to price a season
    // on a league worth six points a week. A genuinely empty week is capped so
    // it stops asking.
    const ks = Object.keys(m), scored = ks.filter(k => m[k].pts != null).length;
    S.projTries = S.projTries || {};
    if (!scored) { if ((S.projTries[week] = (S.projTries[week] || 0) + 1) < 4) return; }
    else if (scored < 50) return;
    S.proj[week] = m;
    projKickSync(week);   // the projection a player carried into his game outlives Sleeper wiping it
}
async function loadStats(week) {
    if (S.stats[week]) return;
    const url = `${API2}/stats/nfl/${S.season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_half_ppr`;
    const list = await rest(url).catch(() => []);
    const m = {};
    for (const x of list) m[x.player_id] = { pid: String(x.player_id), pts: scoreStats(x.stats), opp: x.opponent, stats: x.stats };
    if (week === S.curWeek) for (const x of list) foldStanding(String(x.player_id), x.player);
    S.stats[week] = m;
}
async function loadSeasonProj() {
    if (S.seasonProj) return;
    const url = `${API2}/projections/nfl/${S.season}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_half_ppr`;
    const list = await rest(url).catch(() => []);
    const m = {}, byPos = {};
    for (const x of list) { const pts = scoreStats(x.stats); if (pts == null) continue; m[x.player_id] = { pts, stats: x.stats }; const pos = ppos(x.player_id); (byPos[pos] = byPos[pos] || []).push([x.player_id, pts]); }
    for (const [pos, arr] of Object.entries(byPos)) { arr.sort((a, b) => b[1] - a[1]); arr.forEach(([pid], i) => { m[pid].rank = `${pos}${i + 1}`; }); }
    S.seasonProj = m;
}
async function loadSeasonStats() {
    if (S.seasonStats) return;
    if (S.seasonType !== 'regular') { S.seasonStats = {}; return; }
    const url = `${API2}/stats/nfl/${S.season}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_half_ppr`;
    const list = await rest(url).catch(() => []);
    const m = {};
    for (const x of list) { const pts = scoreStats(x.stats); if (pts == null) continue; m[x.player_id] = { pid: String(x.player_id), pts, gp: (x.stats && x.stats.gp) || 0, stats: x.stats }; }
    await patchSeasonLag(m).catch((e) => console.warn(TAG, 'season lag patch:', e.message));
    S.seasonStats = m;
}
// Sleeper's season totals are rebuilt some hours after a game ends, and snap
// counts later still. The morning after Monday night, every Bronco and Chief
// had an empty season line: Kenneth Walker showed a dash for his points
// after scoring 32.60, and every season snap share read a dash. The weekly lines are
// already right, so a team whose totals trail its completed games gets those
// weeks added from them. Bounded: at most three trailing weeks per team, and
// the snap counts are only rebuilt while the whole season fits in six weeks
// (past that, Sleeper's totals carry them).
async function patchSeasonLag(m) {
    await loadSchedule();
    if (!S.schedule) return;
    const done = {};
    for (const [w, teams] of Object.entries(S.schedule)) for (const [t, g] of Object.entries(teams || {})) if (g && /complete/i.test(g.status || '')) (done[t] = done[t] || []).push(Number(w));
    const lastDone = Math.max(0, ...Object.values(done).flat());
    if (!lastDone) return;
    const teamOf = (pid) => (P(pid) || {}).team || null;
    const maxGp = {};
    for (const [pid, e] of Object.entries(m)) { const t = teamOf(pid); if (t) maxGp[t] = Math.max(maxGp[t] || 0, e.gp || 0); }
    const lag = {}, need = new Set();
    for (const [t, ws] of Object.entries(done)) {
        ws.sort((a, b) => a - b);
        const k = ws.length - (maxGp[t] || 0);
        if (k >= 1 && k <= 3) { lag[t] = new Set(ws.slice(-k)); lag[t].forEach(w => need.add(w)); }
    }
    const early = lastDone <= 6;
    if (early) for (let w = 1; w <= lastDone; w++) need.add(w);
    if (!need.size) return;
    await Promise.all([...need].map(w => loadStats(w)));
    const played = (x) => x && x.stats && ((x.stats.gp || 0) > 0 || (x.stats.off_snp || 0) > 0);
    let added = 0;
    for (const w of need) for (const [pid, x] of Object.entries(S.stats[w] || {})) {
        const t = teamOf(pid);
        if (!t || !lag[t] || !lag[t].has(w) || !played(x)) continue;
        const e = m[pid] = m[pid] || { pid: String(pid), pts: 0, gp: 0, stats: {} };
        e.stats = { ...e.stats };
        e.pts = (e.pts || 0) + (x.pts || 0);
        e.gp = (e.gp || 0) + (x.stats.gp || 1);
        for (const [k2, v] of Object.entries(x.stats)) if (typeof v === 'number' && k2 !== 'gp' && !RATE_KEY.test(k2) && !/^(pos_)?rank_/.test(k2)) e.stats[k2] = (e.stats[k2] || 0) + v;
        e.stats.gp = e.gp; added++;
    }
    if (early) {
        for (const [pid, e] of Object.entries(m)) {
            if (e.stats && e.stats.tm_off_snp) continue;
            let off = 0, tm = 0, n = 0;
            for (let w = 1; w <= lastDone; w++) { const x = (S.stats[w] || {})[pid]; if (!played(x)) continue; off += x.stats.off_snp || 0; tm += x.stats.tm_off_snp || 0; n++; }
            if (tm > 0 && n === (e.gp || 0)) e.stats = { ...e.stats, off_snp: off, tm_off_snp: tm };
        }
    }
    if (added) console.info(TAG, `season totals trail the last games for ${Object.keys(lag).join(', ')} — added ${added} weekly lines`);
}
// He has already played this week: a stat line with a game in it, or points in a
// matchup. An OUT hung on him after that is an injury in the game, not a starter
// who will not play, and nothing about his slot is left to fix.
function playedWeek(pid, week) {
    const st = ((S.stats[week] || {})[pid] || {}).stats;
    if (st && ((st.gp || 0) > 0 || (st.gms_active || 0) > 0 || (st.off_snp || 0) > 0 || (st.def_snp || 0) > 0 || (st.st_snp || 0) > 0)) return true;
    for (const m of (S.matchups[week] || [])) if (m.players_points && m.players_points[pid]) return true;
    return false;
}
// The projection each rostered player carried into his game. Sleeper wipes a
// week's projection the moment a player is ruled out, in the middle of a game
// as well as before it, so a receiver hurt in the third quarter read as a man
// projected for nothing who should never have started. The last projection
// seen BEFORE his kickoff is kept (in this browser, for the current week), and
// put back once his game has started and Sleeper's is gone. One wiped before
// kickoff is dropped here too: that one really is zero.
async function projKickSync(week) {
    const m = S.proj[week], kick = S.kickByWeek && S.kickByWeek[week];
    if (!m || !kick || week !== S.curWeek || !S.rosters || !S.rosters.length) return;
    const key = `badgerProjKick:${S.leagueId}`;
    S.projKick = S.projKick || {};
    if (!S.projKick[week]) {
        let saved = null; try { saved = (await chrome.storage.local.get(key))[key]; } catch (e) { /* no storage: this visit only */ }
        S.projKick[week] = saved && saved.season === S.season && saved.week === week && saved.memo ? saved.memo : {};
    }
    const memo = S.projKick[week], now = Date.now(); let dirty = false, restored = 0;
    for (const R of S.rosters) for (const pid of (R.players || [])) {
        const pl = P(pid), k = pl && pl.team ? kick[pl.team] : null; if (!k) continue;
        const cur = m[pid], live = !!(cur && cur.pts != null && cur.pts > 0);
        if (Date.parse(k.t) > now) {
            if (live) { if (!memo[pid] || memo[pid].pts !== cur.pts) { memo[pid] = { pts: cur.pts, stats: cur.stats, opp: cur.opp, game: cur.game, team: cur.team }; dirty = true; } }
            else if (memo[pid]) { delete memo[pid]; dirty = true; }
        } else if (!live && memo[pid]) { m[pid] = { ...memo[pid], pts: scoreStats(memo[pid].stats) ?? memo[pid].pts, atKickoff: true }; restored++; }
    }
    if (dirty) { try { await chrome.storage.local.set({ [key]: { season: S.season, week, memo } }); } catch (e) { /* kept for this visit */ } }
    if (restored) render();
}
const byeWeekOf = (team) => { if (!S.schedule || !team) return null; for (let w = 1; w <= 18; w++) { const wk = S.schedule[w]; if (wk && Object.keys(wk).length && !wk[team]) return w; } return null; };
const projOf = (pid, week) => { const p = S.proj[week ?? S.week]; return p && p[pid] ? p[pid].pts : null; };
const oppOf = (pid, week) => {
    const p = S.proj[week ?? S.week]; if (p && p[pid] && p[pid].opp) return p[pid].opp;
    const pl = P(pid); if (!pl || !pl.team || !S.schedule) return null;
    const g = (S.schedule[week ?? S.week] || {})[pl.team]; return g ? g.opp : null;
};
const gameOf = (pid, week) => { const pl = P(pid); if (!pl || !pl.team || !S.schedule) return null; return (S.schedule[week ?? S.week] || {})[pl.team] || null; };
const isBye = (pid, week) => { const pl = P(pid); if (!pl || !pl.team || !S.schedule || !S.schedule[week ?? S.week]) return false; return !S.schedule[week ?? S.week][pl.team]; };
const statusOf = (pid) => { const pl = P(pid); return pl && pl.injury_status ? pl.injury_status : null; };
const statusDot = (pid, week) => {
    if (isBye(pid, week)) return h('i', { class: 'st bye', title: 'Bye' });
    const s = statusOf(pid); if (!s) return null;
    const k = /out|ir|pup|sus|na/i.test(s) ? 'o' : /doubt/i.test(s) ? 'd' : 'q';
    return h('i', { class: `st ${k}`, title: s });
};

// ── league data ──────────────────────────────────────────────────────────────
async function loadCore() {
    const [league, rosters, users, state] = await Promise.all([
        rest(`${API}/league/${S.leagueId}`), rest(`${API}/league/${S.leagueId}/rosters`), rest(`${API}/league/${S.leagueId}/users`), rest(`${API}/state/nfl`),
    ]);
    S.league = league; S.rosters = rosters; S.users = users; S.state = state;
    S.season = league.season;
    S.seasonType = state.season_type;
    const inSeason = state.season_type === 'regular' || state.season_type === 'post';
    S.curWeek = inSeason ? Math.max(1, state.display_week || state.week || 1) : (league.settings && league.settings.start_week) || 1;
    S.displayWeek = S.curWeek;   // Sleeper's own week, before settleWeek moves past a finished one
    if (!S.week || S.week < 1) S.week = S.curWeek;
    S.myUserId = resolveMyUserId();
    S.myRoster = rosters.find(r => String(r.owner_id) === String(S.myUserId) || (r.co_owners || []).map(String).includes(String(S.myUserId))) || null;
}
async function loadSchedule() {
    loadDefRanks();   // piggybacks here: needs S.season, never blocks
    if (S.schedule) return;
    const list = await rest(`${API2}/schedule/nfl/regular/${S.season}`).catch(() => []);
    const byWeek = {};
    for (const g of list) {
        const w = byWeek[g.week] = byWeek[g.week] || {};
        w[g.home] = { opp: g.away, home: true, date: g.date, status: g.status, game: g.game_id };
        w[g.away] = { opp: g.home, home: false, date: g.date, status: g.status, game: g.game_id };
    }
    S.schedule = byWeek;
}
// One request per question, however many redraws ask while the answer is on the wire.
// A page that is still loading redraws as each answer lands, and every redraw used to
// ask again for whatever had not landed: a week's matchups went out fifty times, 337
// requests in half a minute of which 272 were repeats.
let kbdNav = false;   // the last thing the person used was the keyboard
const inflight = new Map();
function once(key, run) {
    let p = inflight.get(key);
    if (!p) { p = Promise.resolve().then(run).finally(() => inflight.delete(key)); inflight.set(key, p); }
    return p;
}
// A week's matchups. A failed read is not an empty week: it used to be kept as [],
// and the week then read "No matchups" with a bye until the tab was reloaded. Now
// the last good answer stays (a refresh that fails changes nothing), a week never
// answered stays unanswered, and it is asked again a few seconds on. Resolves true
// when it brought something new.
const MU_RETRY_MS = 4000;
async function loadMatchups(week) {
    if (S.matchups[week]) return false;
    S.muLast = S.muLast || {}; S.muFailAt = S.muFailAt || {};
    if (S.muFailAt[week] && Date.now() - S.muFailAt[week] < MU_RETRY_MS) { if (S.muLast[week]) S.matchups[week] = S.muLast[week]; return false; }
    return once(`matchups:${week}`, async () => {
        try {
            S.matchups[week] = S.muLast[week] = await rest(`${API}/league/${S.leagueId}/matchups/${week}`);
            delete S.muFailAt[week];
        } catch (e) {
            console.info(TAG, `matchups week ${week}:`, e.message, S.muLast[week] ? '— keeping the last answer' : '— asking again shortly');
            S.muFailAt[week] = Date.now();
            if (S.muLast[week]) S.matchups[week] = S.muLast[week];
            else if (!S.muRetry) S.muRetry = setTimeout(() => { S.muRetry = null; render(); }, MU_RETRY_MS + 200);
            return false;
        }
        if (week === lineupRound()) syncLineups();
        return true;
    });
}
// Sleeper's own per-roster projected final. It is not in the public matchups
// REST response — only matchup_legs carries it — and it is the number their win
// bar is built on: server-side, and updated through a game as the clock runs and
// points land. Reading it beats deriving one the way the old muTotal did, which
// is what made our bar lurch at every kickoff as a starter's projection was
// thrown away the instant his game began (muTotal is gone; muProjected keeps
// the unplayed share). max_points rides along: the best lineup that
// roster could have started.
async function loadLegs(week) {
    if (S.legs[week]) return;
    try {
        const d = await gql('matchup_legs', `query matchup_legs { matchup_legs(league_id: "${S.leagueId}", round: ${week}){ roster_id matchup_id points proj_points max_points } }`);
        const m = {}; for (const r of (d.matchup_legs || [])) m[r.roster_id] = r;
        S.legs[week] = m;
    } catch (e) { console.warn(TAG, 'matchup_legs:', e.message); S.legs[week] = {}; }
}
// How much of a player's game is still to be played: 1 before kickoff, 0 after
// the whistle, and the share of sixty minutes left in between.
function gameFracLeft(pid) {
    if (S.fracDone) return 0;                 // vault mode: every game is history
    const k = insKickInfo(pid);
    // No game record for him this week: a week already behind us has nothing
    // left to play (the kickoff map may also still be loading, or be another
    // week's); a week still to come is entirely ahead.
    if (!k) return S.week < S.curWeek ? 0 : 1;
    return kickFracLeft(k);
}
function kickFracLeft(k) {
    if (k.over || k.q === 'F' || /complete|closed/i.test(k.status || '')) return 0;
    if (!k.started && !k.live && Date.parse(k.t) > Date.now()) return 1;
    const qn = k.qn || (/^[1-4]$/.test(k.q || '') ? Number(k.q) : null);
    if (!qn) return 1;                       // started, but no clock yet
    if (qn > 4) return 0.02;                 // overtime: a sliver
    const [mm, ss] = String(k.tr || '15:00').split(':').map(Number);
    const left = (4 - qn) * 15 + (isFinite(mm) ? mm + (isFinite(ss) ? ss : 0) / 60 : 15);
    return Math.max(0, Math.min(1, left / 60));
}
// What a roster's week in progress counts for in the standings: its projected
// final, the points it has plus the unplayed remainder of its starters'
// projections. The score so far credited whoever had played more men: ahead by
// ten with the other side's quarterback still to come is not a win. It reads
// the live week's own kickoff map and projections, whichever week the viewer
// is looking at. With neither in hand there is nothing to project with, and
// the score so far stands; the switch then says "as it stands".
const liveWeekKicks = () => (S.curWeek === S.kickWeek ? S.kick : (S.kickByWeek || {})[S.curWeek]) || null;
const liveWeekProjects = () => !!(S.proj[S.curWeek] && liveWeekKicks());
const liveWord = () => (liveWeekProjects() ? 'as projected' : 'as it stands');
function countedPoints(m) {
    const R = rosterById(m.roster_id), km = liveWeekKicks(), pj = S.proj[S.curWeek];
    if (!R || !km || !pj) return m.points || 0;
    let tot = 0;
    for (const pid of muStarters(R, m)) {
        if (!pid || pid === '0') continue;
        const k = km[(P(pid) || {}).team], got = (m.players_points || {})[pid] || 0, left = k ? kickFracLeft(k) : (got ? 0 : 1);
        tot += (left < 1 ? got : 0) + ((pj[pid] || {}).pts || 0) * left;
    }
    return Math.round(tot * 100) / 100;
}
// A roster's projected final: what it has actually scored, plus the unplayed
// remainder of every starter's projection.
//
// matchup_legs.proj_points is NOT this. It is a static weekly projection — on
// a finished championship it still read some seventeen points above the actual
// score, so it never converges. It equals this quantity before kickoff, which is why
// it matched Sleeper to the cent in a preseason week, and drifts from it
// thereafter. Computing it per player is right in both states.
function muProjected(R, m) {
    if (!R) return 0;
    let tot = 0;
    for (const pid of muStarters(R, m)) {
        if (!pid || pid === '0') continue;
        const left = gameFracLeft(pid);
        const actual = left < 1 ? ((m && m.players_points ? m.players_points[pid] : 0) || 0) : 0;
        tot += actual + (projOf(pid, S.week) || 0) * left;
    }
    return tot;
}
// The projected points that have not happened yet — all the variance there is.
function muUnplayed(R, m) {
    if (!R) return 0;
    let tot = 0;
    for (const pid of muStarters(R, m)) if (pid && pid !== '0') tot += (projOf(pid, S.week) || 0) * gameFracLeft(pid);
    return tot;
}
async function loadTxns(week) { if (S.txns[week]) return; return once(`txns:${week}`, async () => { S.txns[week] = await rest(`${API}/league/${S.leagueId}/transactions/${week}`).catch(() => []); }); }
async function loadResearch() { if (S.research) return; S.research = await rest(`${API2}/players/nfl/research/regular/${S.season}/${Math.max(1, S.displayWeek || S.curWeek)}`).catch(() => ({})); }
async function loadTrending() {
    if (S.trending) return;
    const [add, drop] = await Promise.all([rest(`${API}/players/nfl/trending/add?lookback_hours=24&limit=100`).catch(() => []), rest(`${API}/players/nfl/trending/drop?lookback_hours=24&limit=100`).catch(() => [])]);
    const m = {}; for (const x of add) m[x.player_id] = { add: x.count }; for (const x of drop) (m[x.player_id] = m[x.player_id] || {}).drop = x.count;
    S.trending = m;
}
async function loadWaivers() {
    // Sleeper's own answer to "is he on waivers": league_players lists the
    // recently dropped with waiver_clears_at; with daily waivers on, every
    // unrostered player goes through a claim.
    try {
        const d = await gql('league_players', `query league_players { league_players(league_id: "${S.leagueId}"){ player_id settings } }`);
        const now = Date.now() / 1000; const s = new Set(); const clears = {};
        for (const x of (d.league_players || [])) { const at = x.settings && x.settings.waiver_clears_at; if (at && at > now) { s.add(String(x.player_id)); clears[String(x.player_id)] = at * 1000; } }
        S.waivers = s; S.waiverClears = clears; S.waiversAt = Date.now();
    } catch (e) { console.warn(TAG, 'league_players:', e.message); S.waivers = S.waivers || new Set(); }
}
let watchedLoaded = false;
async function loadWatched() {
    if (watchedLoaded) return;
    try {
        const d = await gql('watched_players', 'query watched_players { watched_players(sport: "nfl"){ player_id } }');
        S.watched = new Set((d.watched_players || []).map(x => String(x.player_id)));
        watchedLoaded = true;
    } catch (e) { console.warn(TAG, 'watched:', e.message); S.watched = S.watched || new Set(); }
}
async function toggleWatch(pid) {
    const on = S.watched && S.watched.has(String(pid));
    const op = on ? 'unwatch_player' : 'watch_player';
    try {
        // unwatch_player returns a bare Boolean — a selection set is a GraphQL error there
        await gql(op, `mutation ${op} { ${op}(sport: "nfl", player_id: "${pid}")${on ? '' : '{ player_id }'} }`);
        if (on) S.watched.delete(String(pid)); else (S.watched = S.watched || new Set()).add(String(pid));
        render();
    } catch (e) { toast(e.message, 'err'); }
}
// The same star as the Sleeper app; account-wide, syncs both ways.
function starEl(pid) {
    const on = S.watched && S.watched.has(String(pid));
    return h('span', { class: `wstar ${on ? 'on' : ''}`, title: on ? 'On your watchlist — click to remove' : 'Watch (syncs with the Sleeper app)', onclick: (e) => { e.stopPropagation(); toggleWatch(pid); } }, on ? '★' : '☆');
}
async function loadPending() {
    try {
        const d = await gql('league_transactions_filtered', `query league_transactions_filtered($league_id: String!, $roster_id_filters: [Int], $type_filters: [String], $leg_filters: [Int], $status_filters: [String], $limit: Int) { league_transactions_filtered(league_id: $league_id, roster_id_filters: $roster_id_filters, type_filters: $type_filters, leg_filters: $leg_filters, status_filters: $status_filters, limit: $limit) { adds consenter_ids created creator draft_picks drops league_id leg metadata roster_ids settings status status_updated transaction_id type waiver_budget } }`,
            { league_id: S.leagueId, roster_id_filters: [], type_filters: [], leg_filters: [], status_filters: ['pending', 'proposed'], limit: 50 });
        // An expired offer keeps status "proposed"; only expires_at says it is dead.
        const now = Date.now() / 1000;
        S.pending = (d.league_transactions_filtered || []).filter(t => !(t.settings && t.settings.expires_at && t.settings.expires_at < now));
    } catch (e) { console.warn(TAG, 'pending:', e.message); S.pending = []; }
}
async function loadNews(pids) {
    const want = pids.filter(id => !S.news[id] && !/^[A-Z]{2,3}$/.test(id)).slice(0, 40);
    if (!want.length) return;
    try {
        const q = `query get_player_news_for_ids { ${want.map(id => `p_${id}: get_player_news(sport: "nfl", player_id: "${id}", limit: 1){ metadata player_id published source }`).join(' ')} }`;
        const d = await gql('get_player_news_for_ids', q);
        for (const id of want) S.news[id] = (d[`p_${id}`] || [])[0] || false;
    } catch (e) { console.warn(TAG, 'news:', e.message); for (const id of want) S.news[id] = false; }
}
// The stories before the newest one: the same query, asked for ten instead of
// one, and only when the card's News tab is opened. One small request per
// player, kept for the session.
const NEWS_MORE = 10;
async function loadNewsMore(pid) {
    S.newsMore = S.newsMore || {};
    const had = S.newsMore[pid];
    if (had && !had.error) return;
    S.newsMore[pid] = { loading: true };
    try {
        const d = await gql('get_player_news', `query get_player_news { get_player_news(sport: "nfl", player_id: "${pid}", limit: ${NEWS_MORE}){ metadata player_id published source } }`);
        S.newsMore[pid] = { items: d.get_player_news || [] };
    } catch (e) { console.warn(TAG, 'older news:', e.message); S.newsMore[pid] = { error: e.message, at: Date.now() }; }
}
// text_map carries the structured mentions and the flair badges; reactions and
// user_reactions carry who reacted with what. user_reactions is YOUR reactions
// only, as {reaction, reactor_id} objects; reactions is the count per name.
const MSG_FIELDS = 'author_display_name author_id author_avatar created message_id parent_id text text_map attachment pinned reactions user_reactions';
// ── conversations: one model for the league chat and every DM ────────────────
// A conversation id is 'league' or a dm_id. What Sleeper's own web client does,
// read out of its bundle and checked against a live league: the league socket
// channel pushes message_created, the user channel pushes received_message for
// DMs, read_receipts / create_read_receipt keep the read line, messages(before:)
// pages back fifty at a time, and pinned_messages lists the pins.
const CHAT_PAGE = 50;
const chatParent = (cid) => cid === 'league' ? S.leagueId : cid;
const chatType = (cid) => cid === 'league' ? 'league' : 'dm';
const chatList = (cid) => cid === 'league' ? S.messages : S.dmMsgs[cid];
const idGt = (a, b) => { try { return BigInt(String(a)) > BigInt(String(b)); } catch (e) { return false; } };
const isBotMsg = (m) => !!m && (String(m.author_id) === '166666666666666666' || m.author_display_name === 'sys');
function mergeMsgs(list, incoming) {
    const by = new Map();
    for (const m of list || []) if (m && m.message_id) by.set(String(m.message_id), m);
    for (const m of incoming || []) if (m && m.message_id) by.set(String(m.message_id), Object.assign({}, by.get(String(m.message_id)) || {}, m));
    return [...by.values()].sort((a, b) => a.created - b.created);
}
function setChatList(cid, list) { if (cid === 'league') S.messages = list; else S.dmMsgs[cid] = list; }
async function loadMessages() { return loadConvo('league'); }
async function loadDmMessages(dmId) { return loadConvo(dmId); }
// The latest page, merged into whatever is loaded (older pages survive a
// refresh), plus the pins and, for the league, where you last read to. A DM's
// read line rides my_dms. Receipts and pins are extras: their failure never
// blanks the conversation.
async function loadConvo(cid) {
    const pid = chatParent(cid);
    try {
        const d = await gql('messages', `query messages { messages(parent_id: "${pid}") { ${MSG_FIELDS} } }`);
        setChatList(cid, mergeMsgs(chatList(cid), d.messages || []));
    } catch (e) { console.warn(TAG, 'messages:', e.message); if (!chatList(cid)) setChatList(cid, []); }
    const extras = [
        gql('pinned_messages', `query pinned_messages { pinned_messages(parent_id: "${pid}") { ${MSG_FIELDS} } }`)
            .then(d => { S.chatPins[cid] = (d.pinned_messages || []).slice().sort((a, b) => b.created - a.created); })
            .catch(() => { S.chatPins[cid] = S.chatPins[cid] || []; }),
    ];
    if (cid === 'league') extras.push(gql('read_receipts', `query read_receipts { read_receipts(parent_type: "league", parent_id: "${pid}") { user_id last_read_id } }`)
        .then(d => { const mine = (d.read_receipts || []).find(x => String(x.user_id) === String(S.myUserId)); if (mine && mine.last_read_id && (!S.chatRead.league || idGt(mine.last_read_id, S.chatRead.league))) S.chatRead.league = String(mine.last_read_id); })
        .catch(() => {}));
    await Promise.all(extras);
}
// Fifty at a time, before the oldest one loaded. Fewer than a page back means
// the start of the conversation.
async function loadOlder(cid) {
    const list = chatList(cid);
    if (!list || !list.length || S.chatOlder[cid]) return;
    S.chatOlder[cid] = 'busy';
    try {
        const d = await gql('messages', `query messages { messages(parent_id: "${chatParent(cid)}", before: "${list[0].message_id}") { ${MSG_FIELDS} } }`);
        const got = (d.messages || []).filter(m => String(m.message_id) !== String(list[0].message_id));
        setChatList(cid, mergeMsgs(chatList(cid), got));
        S.chatOlder[cid] = got.length < CHAT_PAGE - 1 ? 'done' : null;
    } catch (e) { console.warn(TAG, 'older messages:', e.message); S.chatOlder[cid] = null; toast('Could not load older messages'); }
}
// ── direct messages ──────────────────────────────────────────────────────────
// A DM is the same message model with a different parent. Trade offers arrive
// here — five of a typical league's conversations are nothing else — and the
// attachment carries the whole trade, so it can be read without leaving.
async function loadDms() {
    try {
        const d = await gql('my_dms', `query my_dms { my_dms(limit: 30) { dm_id dm_type title last_message_text last_message_time last_author_display_name last_author_id last_read_id last_message_id recent_users } }`);
        S.dms = (d.my_dms || []).slice().sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
    } catch (e) { console.warn(TAG, 'dms:', e.message); S.dms = S.dms || []; }
}
// Unread is a fact now, not a guess. A DM is unread when Sleeper's read line is
// behind its last message and that message is not yours; the league chat counts
// the messages from people after your read line. System rows never count.
const dmUnread = (c) => !!c && !!c.last_message_id && String(c.last_read_id || '') !== String(c.last_message_id) && String(c.last_author_id || '') !== String(S.myUserId);
const unreadDms = () => (S.dms || []).filter(dmUnread).length;
function leagueUnread() {
    const r = S.chatRead.league; if (!r) return 0;
    return S.messages.filter(m => idGt(m.message_id, r) && !isBotMsg(m) && String(m.author_id) !== String(S.myUserId)).length;
}
// Tell Sleeper you have read to here, the way its own client does, so the
// phone agrees with the tab. Only ever forward.
async function markRead(cid, mid) {
    if (!mid) return;
    const cur = cid === 'league' ? S.chatRead.league : ((convoOf(cid) || {}).last_read_id || S.chatRead[cid]);
    if (cur && !idGt(mid, cur)) return;
    S.chatRead[cid] = String(mid);
    const c = cid === 'league' ? null : convoOf(cid); if (c) c.last_read_id = String(mid);
    try { await gql('create_receipt', `query create_receipt { create_read_receipt(parent_type: "${chatType(cid)}", parent_id: "${chatParent(cid)}", message_id: "${mid}") }`); }
    catch (e) { console.warn(TAG, 'read receipt:', e.message); }
}
// A message that arrived by push, or came back from sending. Returns whether it
// belonged to a conversation we track.
function chatPush(cid, msg) {
    if (!msg || !msg.message_id) return false;
    if (cid === 'league') {
        if (msg.parent_id && String(msg.parent_id) !== String(S.leagueId)) return false;
        S.messages = mergeMsgs(S.messages, [msg]);
    } else {
        if (S.dmMsgs[cid]) S.dmMsgs[cid] = mergeMsgs(S.dmMsgs[cid], [msg]);
        const c = convoOf(cid);
        if (!c) { if (!S.dmBusy) { S.dmBusy = true; loadDms().then(() => { S.dmBusy = false; render(); }).catch(() => { S.dmBusy = false; }); } }
        else if (!c.last_message_id || !idGt(c.last_message_id, msg.message_id)) {
            Object.assign(c, { last_message_id: String(msg.message_id), last_message_text: msg.text || '', last_message_time: msg.created, last_author_id: msg.author_id, last_author_display_name: msg.author_display_name });
            if (String(msg.author_id) === String(S.myUserId)) c.last_read_id = String(msg.message_id);
            S.dms.sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
        }
    }
    return true;
}
function chatDrop(cid, mid) {
    const list = chatList(cid); if (!list) return;
    setChatList(cid, list.filter(m => String(m.message_id) !== String(mid)));
    if (S.chatPins[cid]) S.chatPins[cid] = S.chatPins[cid].filter(m => String(m.message_id) !== String(mid));
}
async function deleteMessage(cid, m) {
    await gql('delete_message', `mutation delete_message { delete_message(message_id: "${m.message_id}", parent_id: "${chatParent(cid)}") }`);
    chatDrop(cid, m.message_id);
}
// A trade offer's status as it is NOW. The attachment froze "proposed" the day
// it was sent; the league's own transactions say what became of it. One query
// per league, this season's or any earlier one in the chain.
async function loadTradeStatuses(leagueId) {
    if (!leagueId || S.txnStatus[leagueId]) return;
    S.txnStatus[leagueId] = 'busy';
    try {
        const d = await gql('league_transactions_filtered', `query league_transactions_filtered($league_id: String!, $roster_id_filters: [Int], $type_filters: [String], $leg_filters: [Int], $status_filters: [String], $limit: Int) { league_transactions_filtered(league_id: $league_id, roster_id_filters: $roster_id_filters, type_filters: $type_filters, leg_filters: $leg_filters, status_filters: $status_filters, limit: $limit) { transaction_id status settings status_updated } }`,
            { league_id: String(leagueId), roster_id_filters: [], type_filters: ['trade'], leg_filters: [], status_filters: [], limit: 200 });
        const map = {}; for (const t of d.league_transactions_filtered || []) map[String(t.transaction_id)] = t;
        S.txnStatus[leagueId] = map;
    } catch (e) { console.warn(TAG, 'trade statuses:', e.message); S.txnStatus[leagueId] = {}; }
}

// ── roster model ─────────────────────────────────────────────────────────────
const rosterPositions = () => (S.league && S.league.roster_positions) || [];
const starterSlots = () => rosterPositions().filter(p => p !== 'BN' && p !== 'IR' && p !== 'TAXI');
const slotEligible = (slot, pid) => {
    const pl = P(pid); if (!pl) return false;
    const fps = pl.fantasy_positions || [pl.position];
    if (FLEX[slot]) return fps.some(p => FLEX[slot].includes(p));
    return fps.includes(slot);
};
const userOf = (roster) => S.users.find(u => String(u.user_id) === String(roster && roster.owner_id)) || null;
const teamName = (roster) => { const u = userOf(roster); return (u && u.metadata && u.metadata.team_name && u.metadata.team_name.trim()) || (u && u.display_name) || `Team ${roster ? roster.roster_id : '?'}`; };
const teamAvatar = (roster) => { const u = userOf(roster); return (u && u.metadata && u.metadata.avatar) || (u && u.avatar && avatarUrl(u.avatar)) || null; };
const rosterById = (id) => S.rosters.find(r => String(r.roster_id) === String(id)) || null;
const ownerOf = (pid) => S.rosters.find(r => (r.players || []).includes(pid)) || null;   // who rosters him, league-wide
// Sleeper's player nicknames: a team names the players on its own roster (its metadata, p_nick_<pid>). A team keeps
// names for players it has let go, so only the team that has him now names him.
const nickOf = (pid) => { const R = ownerOf(pid), v = R && R.metadata ? R.metadata[`p_nick_${pid}`] : null; return v && String(v).trim() ? String(v).trim() : null; };
const record = (r) => `${r.settings.wins}–${r.settings.losses}${r.settings.ties ? '–' + r.settings.ties : ''}`;
const pf = (r) => (r.settings.fpts || 0) + (r.settings.fpts_decimal || 0) / 100;
const pa = (r) => (r.settings.fpts_against || 0) + (r.settings.fpts_against_decimal || 0) / 100;
const faabLeft = (r) => Math.max(0, ((S.league.settings || {}).waiver_budget || 0) - (r.settings.waiver_budget_used || 0));
const rosterRank = (lv) => S.rosters.slice().sort((a, b) => lv
    ? (lv[b.roster_id].w - lv[a.roster_id].w) || (lv[b.roster_id].pf - lv[a.roster_id].pf)
    : (b.settings.wins - a.settings.wins) || (pf(b) - pf(a)));
// Every roster with the week in progress counted: the settled record and points,
// plus this week's game at its projected final (whoever is projected to win takes it).
function liveStand() {
    const out = {}, ms = S.matchups[S.curWeek] || [];
    for (const R of S.rosters) out[R.roster_id] = { w: R.settings.wins || 0, l: R.settings.losses || 0, t: R.settings.ties || 0, pf: pf(R), pa: pa(R), res: null, pts: 0, opp: 0 };
    const by = {}; for (const m of ms) if (m.matchup_id != null) (by[m.matchup_id] = by[m.matchup_id] || []).push(m);
    for (const pair of Object.values(by)) if (pair.length === 2) {
        const [x, y] = pair, a = countedPoints(x), c = countedPoints(y), X = out[x.roster_id], Y = out[y.roster_id]; if (!X || !Y) continue;
        X.pf += a; X.pa += c; X.pts = a; X.opp = c; Y.pf += c; Y.pa += a; Y.pts = c; Y.opp = a;
        if (a > c) { X.w++; Y.l++; X.res = 'W'; Y.res = 'L'; } else if (c > a) { Y.w++; X.l++; X.res = 'L'; Y.res = 'W'; } else { X.t++; Y.t++; X.res = Y.res = 'T'; }
    }
    return out;
}
const projTotal = (roster, week) => starterSlots().reduce((t, slot, i) => { const pid = (roster.starters || [])[i]; return t + ((pid && pid !== '0') ? (projOf(pid, week) || 0) : 0); }, 0);
const rosteredSet = () => { const s = new Set(); for (const r of S.rosters) for (const pid of (r.players || [])) s.add(pid); return s; };
function bestLineup(roster, week, locked) {
    // Greedy in slot-specificity order: fixed positions first, then the flexes,
    // each taking the highest-projected unused eligible player. Byes and OUT
    // score zero, so they fall to the bench on their own.
    const slots = starterSlots();
    const avail = new Set((roster.players || []).filter(pid => !(roster.reserve || []).includes(pid) && !(roster.taxi || []).includes(pid)));
    const val = (pid) => (isBye(pid, week) || /out|ir|pup|sus/i.test(statusOf(pid) || '')) ? 0 : (projOf(pid, week) || 0);
    const out = new Array(slots.length).fill('0');
    // A man whose game has kicked off cannot move: a locked starter keeps his
    // slot, a locked bench man stays on the bench. Sleeper refuses the whole
    // lineup if any of them moves, so the rest is filled around them.
    const held = new Set();
    if (locked) {
        slots.forEach((s, i) => { const pid = (roster.starters || [])[i]; if (pid && pid !== '0' && locked(pid)) { out[i] = pid; held.add(i); } });
        for (const pid of avail) if (locked(pid)) avail.delete(pid);
    }
    const order = slots.map((s, i) => ({ s, i, k: FLEX[s] ? 1 : 0 })).filter(x => !held.has(x.i)).sort((a, b) => a.k - b.k);
    for (const { s, i } of order) {
        let best = null, bv = -1;
        for (const pid of avail) if (slotEligible(s, pid)) { const v = val(pid); if (v > bv) { bv = v; best = pid; } }
        if (best) { out[i] = best; avail.delete(best); }
    }
    return out;
}
// The same starters in better slots. A flex takes a back, receiver or tight
// end; a WR slot takes only receivers. So the later a man's game, the more use
// a flex slot is to him: while it is still open you can replace him with any of
// three positions, and inactives land 90 minutes before each kickoff. Early
// games go in the fixed slots, late games in the flex. Nobody is benched and
// the projection does not move — only which slot each starter sits in.
// A questionable or doubtful starter is the likeliest late scratch, and the flex
// is the slot that can be refilled from any of three positions — so he goes
// there before a healthy man who merely plays later. Given `starters`, it
// arranges a proposed lineup (Set best lineup's) and reports its moves
// against the one you have.
const lateDoubt = (pid) => /^(questionable|doubtful)$/i.test(statusOf(pid) || '') ? 1 : 0;
function lateFlex(R, week, starters) {
    const slots = starterSlots();
    const ref = (R.starters || []).slice(), cur = (starters || ref).slice();
    if (!slots.length || !slots.some(s => FLEX[s]) || cur.length !== slots.length) return null;
    const when = (pid) => {
        const k = insKickInfo(pid), t = k && Date.parse(k.t);
        if (isFinite(t)) return t;
        const g = gameOf(pid, week), d = g && g.date ? Date.parse(`${g.date}T17:00:00Z`) : NaN;
        return isFinite(d) ? d : 0;
    };
    const out = new Array(slots.length).fill(null), pool = [];
    slots.forEach((sl, i) => {
        const pid = cur[i];
        // an empty slot stays empty, and a man whose game has kicked off cannot move
        if (!pid || pid === '0' || muLocked(pid)) { out[i] = pid || '0'; return; }
        pool.push({ pid, pos: ppos(pid), ts: when(pid), q: lateDoubt(pid), i });
    });
    const open = slots.map((sl, i) => out[i] == null ? { sl, i, elig: FLEX[sl] || null } : null).filter(Boolean);
    // Fixed slots take the most CERTAIN, then the EARLIEST, eligible man of their
    // own position, which leaves the doubtful and the latest for the flexes; the
    // tightest flex is filled first.
    for (const f of open.filter(x => !x.elig)) {
        const c = pool.filter(x => !x.used && x.pos === f.sl).sort((a, b) => a.q - b.q || a.ts - b.ts || a.i - b.i);
        if (!c.length) return null;                     // a lineup we do not understand: leave it alone
        c[0].used = true; out[f.i] = c[0].pid;
    }
    for (const f of open.filter(x => x.elig).sort((a, b) => a.elig.length - b.elig.length)) {
        const c = pool.filter(x => !x.used && f.elig.includes(x.pos)).sort((a, b) => b.q - a.q || b.ts - a.ts || a.i - b.i);
        if (!c.length) return null;
        c[0].used = true; out[f.i] = c[0].pid;
    }
    if (pool.some(x => !x.used)) return null;
    // Slots with the same label are interchangeable: RB and RB are one slot
    // twice over. Keep each man where he already sits inside such a group, or
    // the two backs swap places and the lineup "changes" without changing.
    const byLabel = {};
    slots.forEach((sl, i) => { (byLabel[sl] = byLabel[sl] || []).push(i); });
    for (const sl in byLabel) {
        const idx = byLabel[sl]; if (idx.length < 2) continue;
        const men = idx.map(i => out[i]), keep = new Array(idx.length).fill(null);
        idx.forEach((i, k) => { const at = men.indexOf(ref[i]); if (at >= 0 && !men[at].taken) { keep[k] = ref[i]; men[at] = { taken: true }; } });
        const rest = men.filter(m => m && !m.taken);
        idx.forEach((i, k) => { out[i] = keep[k] || rest.shift(); });
    }
    const moves = out.map((pid, i) => ({ pid, to: slots[i], from: ref.indexOf(pid) >= 0 ? slots[ref.indexOf(pid)] : null, q: lateDoubt(pid), i })).filter(m => m.pid && m.pid !== '0' && m.pid !== ref[m.i]);
    const times = pool.map(x => x.ts).filter(Boolean);
    // With nothing to move, say WHY: often a man does play later but his
    // position has no spare body — two backs for two RB slots pin both.
    let pinned = null;
    if (!moves.length) {
        const at = (i) => (pool.find(x => x.pid === out[i]) || {}).ts || 0;
        const flexTimes = slots.map((sl, i) => FLEX[sl] ? at(i) : null).filter(t => t != null);
        const soonestFlex = flexTimes.length ? Math.min(...flexTimes) : Infinity;
        const stuck = slots.map((sl, i) => (!FLEX[sl] && at(i) > soonestFlex && slots.some(s2 => FLEX[s2] && FLEX[s2].includes(ppos(out[i])))) ? { pid: out[i], sl, ts: at(i) } : null)
            .filter(Boolean).sort((a, b) => b.ts - a.ts);
        pinned = stuck[0] || null;
    }
    return { starters: out, moves, pinned, oneKickoff: times.length > 1 && new Set(times).size === 1, when };
}
function weakSlot(roster, week) {
    const slots = starterSlots(); let worst = null, wv = Infinity;
    slots.forEach((s, i) => { const pid = (roster.starters || [])[i]; const v = (pid && pid !== '0') ? (projOf(pid, week) || 0) : 0; if (v < wv) { wv = v; worst = FLEX[s] ? 'FLEX' : s; } });
    return worst;
}
function surplus(roster) {
    const counts = {}; for (const pid of roster.players || []) { const p = ppos(pid); counts[p] = (counts[p] || 0) + 1; }
    const need = {}; for (const s of starterSlots()) if (!FLEX[s]) need[s] = (need[s] || 0) + 1;
    let best = null, bd = 0; for (const p of ['RB', 'WR', 'TE', 'QB']) { const d = (counts[p] || 0) - (need[p] || 0); if (d > bd) { bd = d; best = { pos: p, n: counts[p] }; } }
    return best;
}

// ── actions (Sleeper's own mutations) ────────────────────────────────────────
const TXN_FIELDS = 'adds consenter_ids created creator drops league_id leg metadata roster_ids settings status status_updated transaction_id type';
// In season a lineup lives on the WEEK'S MATCHUP, not the roster. Sleeper's own
// client saves it with update_matchup_leg for the current round and never calls
// roster_update_starters once the season is under way; the roster's starters are
// then mirrored from the matchup. Writing the roster instead changed a copy that
// does not score: a kicker set here showed on the page and was an empty slot in
// the week Sleeper actually scored. Before the draft and after the season there
// is no matchup, and the roster is the lineup — the call Sleeper makes then.
const scoringRound = () => Number((S.state && (S.state.leg || S.state.week)) || S.curWeek);
// …and the week a lineup belongs to. Sleeper keeps one on every week's matchup:
// the round in progress is the one it scores, and a later week holds the lineup
// set ahead for it — Sleeper's own app reads and writes the week on screen.
// Keying everything to the scoring round showed week 3's lineup under "Week 4",
// and saved a week-4 change into week 3, the week in progress — as it did every
// Tuesday, once the pages had turned and Sleeper's round had not. A past week
// keeps the scoring round: it is a record, not something to set.
const lineupRound = () => { const r = scoringRound(); return S.week > r && S.week <= LAST_WEEK ? S.week : r; };
async function setStarters(starters) {
    const rid = S.myRoster.roster_id;
    if (S.league && S.league.status === 'in_season') {
        const round = lineupRound();
        const d = await gql('update_matchup_leg', `mutation update_matchup_leg($starters_games: Map) { update_matchup_leg(league_id: "${S.leagueId}", roster_id: ${rid}, leg: ${round}, round: ${round}, starters: ${gqlList(starters)}, starters_games: $starters_games){ league_id leg matchup_id roster_id round starters players points } }`, {});
        const leg = d && d.update_matchup_leg;
        if (!leg || !Array.isArray(leg.starters)) throw new Error('Sleeper did not confirm the lineup');
        S.myRoster.starters = leg.starters.slice();
        const mu = (S.matchups[round] || []).find(m => m.roster_id === rid); if (mu) mu.starters = leg.starters.slice();
        return;
    }
    const d = await gql('roster_update_starters', `mutation roster_update_starters { roster_update_starters(league_id: "${S.leagueId}", roster_id: ${rid}, starters: ${gqlList(starters)}){ league_id roster_id starters players reserve taxi settings } }`);
    Object.assign(S.myRoster, d.roster_update_starters);
}
// Re-read this round's matchups (and so the lineups) alongside a roster re-read.
// A cached copy would put an old lineup over a fresh roster.
function reloadLineups() { if (!S.league || S.league.status !== 'in_season') return null; const w = lineupRound(); if (w === S.week) return null; S.matchups[w] = null; return loadMatchups(w); }
// The lineup a roster will be SCORED with this week is the matchup's. Sleeper
// keeps the roster's copy in step when lineups are set its way, but a copy set
// the old way (or by anything else) can drift, and a page that reads the roster
// then shows a player who is not playing for you. In season, the current
// round's matchup wins.
function syncLineups() {
    if (!S.league || S.league.status !== 'in_season') return;
    const ms = S.matchups[lineupRound()];
    if (!Array.isArray(ms)) return;
    for (const m of ms) {
        const R = rosterById(m.roster_id);
        if (R && Array.isArray(m.starters) && m.starters.length) R.starters = m.starters.slice();
    }
}
async function setReserve(reserve) {
    const d = await gql('roster_update_reserve', `mutation roster_update_reserve { roster_update_reserve(league_id: "${S.leagueId}", roster_id: ${S.myRoster.roster_id}, reserve: ${gqlList(reserve)}){ league_id roster_id starters players reserve taxi settings } }`);
    Object.assign(S.myRoster, d.roster_update_reserve);
}
async function addDrop(adds, drops) {
    const a = kv(adds), dr = kv(drops);
    const d = await gql('league_create_transaction', `mutation league_create_transaction($k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]) { league_create_transaction(league_id: "${S.leagueId}", type: "free_agent", k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops){ ${TXN_FIELDS} } }`, { k_adds: a.keys, v_adds: a.values, k_drops: dr.keys, v_drops: dr.values });
    return d.league_create_transaction;
}
async function submitClaim(adds, drops, bid) {
    const a = kv(adds), dr = kv(drops), st = kv({ waiver_bid: Math.max(0, Math.round(bid || 0)) });
    const d = await gql('submit_waiver_claim', `mutation submit_waiver_claim($k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int], $k_settings: [String], $v_settings: [Int]) { submit_waiver_claim(league_id: "${S.leagueId}", k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops, k_settings: $k_settings, v_settings: $v_settings){ ${TXN_FIELDS} } }`, { k_adds: a.keys, v_adds: a.values, k_drops: dr.keys, v_drops: dr.values, k_settings: st.keys, v_settings: st.values });
    return d.submit_waiver_claim;
}
// What a claim's settings hold, ready to send back: whole numbers only (the bid,
// and its place in your claim order once that has been set). Sleeper's own
// client sends them back whole on a change, so a change made here does too.
const claimSettings = (t, patch) => { const out = {}; for (const [k, v] of Object.entries(Object.assign({}, (t && t.settings) || {}, patch || {}))) if (Number.isInteger(v)) out[k] = v; return out; };
const updateClaim = (txn, bid) => setClaimSettings(txn, claimSettings(txn, { waiver_bid: Math.max(0, Math.round(bid || 0)) }));
async function setClaimSettings(txn, settings) {
    const st = kv(settings);
    const d = await gql('update_waiver_claim', `mutation update_waiver_claim($k_settings: [String], $v_settings: [Int]) { update_waiver_claim(league_id: "${S.leagueId}", transaction_id: "${txn.transaction_id}", leg: ${txn.leg}, k_settings: $k_settings, v_settings: $v_settings){ ${TXN_FIELDS} } }`, { k_settings: st.keys, v_settings: st.values });
    return d.update_waiver_claim;
}
async function cancelClaim(txn) {
    const d = await gql('cancel_waiver_claim', `mutation cancel_waiver_claim { cancel_waiver_claim(league_id: "${S.leagueId}", leg: ${txn.leg}, transaction_id: "${txn.transaction_id}"){ ${TXN_FIELDS} } }`);
    return d.cancel_waiver_claim;
}
// The order a team's claims are tried in, as Sleeper's own client sorts them: the
// bigger bid first, then the place you gave it, then the order they were filed.
const claimKey = (t) => { const s = t.settings || {}; return { bid: s.waiver_bid || 0, prio: Number.isInteger(s.priority) ? s.priority : Infinity, id: String(t.transaction_id) }; };
const byClaimKey = (a, b) => b.bid - a.bid || (a.prio === b.prio ? 0 : a.prio - b.prio) || a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Claims in the order they should be tried, and what has to be sent to make it so:
// [claim, place] pairs, none when Sleeper's own order already agrees. A claim
// filed again is a new claim and would otherwise be tried after every other claim
// of yours at the same bid. `wanted` must already run bigger bid first.
function claimOrderWrites(wanted) {
    const natural = wanted.map(t => Object.assign(claimKey(t), { t })).sort(byClaimKey).map(r => r.t);
    if (natural.every((t, i) => t === wanted[i])) return [];
    return wanted.map((t, i) => [t, i]).filter(([t, i]) => (t.settings || {}).priority !== i);
}
// The commissioner's two moves on a trade in league review, Sleeper's own PROCESS TRADE and REMOVE TRADE (said
// "Approve trade" and "Veto trade" here: the user's words): process_transaction puts it through now, force_cancel_transaction ends it.
async function commishTrade(txn, process) {
    const op = process ? 'process_transaction' : 'force_cancel_transaction';
    const d = await gql(op, `mutation ${op} { ${op}(league_id: "${S.leagueId}", transaction_id: "${txn.transaction_id}", leg: ${txn.leg}){ ${TXN_FIELDS} } }`);
    return d[op];
}
async function respondTrade(txn, accept) {
    const op = accept ? 'accept_trade' : 'reject_trade';
    const d = await gql(op, `mutation ${op} { ${op}(league_id: "${S.leagueId}", transaction_id: "${txn.transaction_id}", leg: ${txn.leg}){ ${TXN_FIELDS} } }`);
    return d[op];
}
// A reply is an ATTACHMENT, not a field — which is why the Message type's own
// field list never mentions one. The quoted text and author ride along with it,
// so a reply renders without fetching the message it answers.
async function sendMessage(text, opts) {
    const o = opts || {};
    const parentId = o.parentId || S.leagueId;
    const parentType = o.parentType || 'league';
    const cid = `badger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const r = o.replyTo;
    const kv = r
        ? `, attachment_type: "reply", k_attachment_data: ["messageId","displayName","text"], v_attachment_data: [$rid, $rname, $rtext]`
        : '';
    const decl = r ? '($text: String, $rid: String, $rname: String, $rtext: String)' : '($text: String)';
    const vars = r ? { text, rid: String(r.message_id), rname: r.author_display_name || '', rtext: (r.text || '').slice(0, 300) } : { text };
    const d = await gql('create_message',
        `mutation create_message${decl} { create_message(parent_id: "${parentId}", client_id: "${cid}", parent_type: "${parentType}", text: $text${kv}) { ${MSG_FIELDS} } }`, vars);
    return d.create_message;
}
// Sleeper draws its own reaction art — fourteen named PNGs, not Unicode. The
// mutation takes a free-form string, so anything would be accepted and only
// these render in Sleeper's own clients.
const SLEEPER_EMOJI = ['like', 'happy', 'facepalm', 'sad', 'shock', 'thinking', 'heart', 'fire', 'poop', 'eyes', 'angry', 'clown', 'goat', 'smart'];
const emojiUrl = (name) => `https://sleepercdn.com/images/emoji/${name}.png`;
// A reaction posted from somewhere else can carry a name Sleeper has no art for;
// it reads as its word rather than a broken image.
const emojiEl = (name, cls) => h('img', { class: `em ${cls || ''}`.trim(), src: emojiUrl(name), alt: name, title: name, loading: 'lazy',
    onerror: (e) => { const w = h('span', { class: 'emw' }, String(name).slice(0, 12)); e.target.replaceWith(w); } });
async function reactTo(m, parentId, name, on) {
    const op = on ? 'delete_reaction' : 'create_reaction';
    await gql(op, `mutation ${op} { ${op}(message_id: "${m.message_id}", parent_id: "${parentId}", reaction: "${name}") { message_id reaction reactor_id } }`);
}

// ── boot & routing ───────────────────────────────────────────────────────────
function parseRoute() {
    const m = location.pathname.match(/^\/leagues\/(\d+)(?:\/([a-z_]+))?/);
    if (!m) return null;
    // Our pages ride on the hash; Sleeper's own paths map underneath. Sleeper's
    // SPA rewrites /leagues/<id> to /matchup before this script runs, so the
    // bare path cannot mean Home -- the first visit to a league in a tab does.
    const hm = location.hash.match(/^#\/(home|team|players|matchup|league)$/);
    const map = { undefined: 'home', league: 'league', team: 'team', matchup: 'matchup', players: 'players', trend: 'players', trades: 'league', scores: 'matchup', settings: 'league' };
    let page = hm ? hm[1] : (map[m[2]] || 'home');
    let first = false, last = null;
    try { const k = 'badgerLeagueSeen-' + m[1]; first = !sessionStorage.getItem(k); if (first) sessionStorage.setItem(k, '1'); last = sessionStorage.getItem('badgerLeaguePage-' + m[1]); } catch (e) {}
    // Sleeper's router strips the hash on its own redirect, so the page we
    // were on is also remembered per league for the reload case.
    if (!hm && first) page = 'home';
    else if (!hm && last) page = last;
    return { leagueId: m[1], page, sub: m[2] || null };
}
const routeFor = (page) => `/leagues/${S.leagueId}/${page === 'home' ? 'matchup' : page === 'league' ? 'settings' : page}#/${page}`;
// The Team page can show ANY roster; only your own is editable.
function viewedTeam() { return (S.ui.teamRoster && rosterById(S.ui.teamRoster)) || S.myRoster; }
function goTeam(rid) { S.ui.teamRoster = (S.myRoster && rid === S.myRoster.roster_id) ? null : rid; S.ui.swapFrom = null; S.ui.teamPop = null; S.ui.teamMenu = false; go('team'); }
function teamLink(R, label) {
    if (!R) return h('span', null, label || '—');
    return h('span', { class: 'tlink', title: `Open ${teamName(R)}`, onclick: (e) => { e.stopPropagation(); goTeam(R.roster_id); } }, label || teamName(R));
}
// Home and League carry no week control, so neither shows a week that was
// picked on another page: arriving on one returns to the week in progress.
function leavePick(page) {
    if (page === 'home' || page === 'league') S.ui.weekPicked = false;
    if (S.ui.weekPicked || S.seasonType !== 'regular') return;
    const w = defaultWeek(page);
    if (w !== S.week) { S.week = w; syncLineups(); }
}
function go(page, opts) {
    S.page = page; S.ui.vault = null;
    leavePick(page);
    try { sessionStorage.setItem('badgerLeaguePage-' + S.leagueId, page); } catch (e) {}
    if (opts && opts.playersTab) S.ui.playersTab = opts.playersTab;
    if (opts && opts.teamPop) S.ui.teamPop = opts.teamPop;
    try { history.pushState({ badger: true }, '', routeFor(page)); } catch (e) {}
    render();
    ensureData().then(render).catch(fail);
    app.scrollTop = 0; window.scrollTo(0, 0);
}
async function ensureData() {
    const w = S.week;
    const jobs = [loadProj(w), loadMatchups(w), loadLegs(w), loadTxns(w), loadKickoffs().catch(() => {})];
    if (S.league && S.league.status === 'in_season' && w !== lineupRound()) jobs.push(loadMatchups(lineupRound()));   // the lineups live on this round's matchups
    if (S.page === 'home' || S.page === 'team') jobs.push(loadPending());
    if (S.page === 'team') jobs.push(loadSeasonProj(), loadSeasonStats(), loadStats(w), loadResearch());
    jobs.push(loadWatched());
    if (S.page === 'home') jobs.push(loadTxns(Math.max(1, w - 1)).catch(() => {}), loadTrending());
    if (S.page === 'home' && turnWeek()) { const tw = turnWeek(); jobs.push(loadMatchups(tw), loadProj(tw).catch(() => {})); }
    if (S.page === 'players') jobs.push(loadResearch(), loadTrending(), loadPending(), loadWaivers(), loadSeasonProj(), loadSeasonStats(), loadStats(w));
    if (S.page === 'matchup') jobs.push(loadStats(w), loadPlays(w).catch(() => {}));
    if (S.page === 'league') jobs.push(loadSeasonStats());
    const b = S.ui.basis;
    if ((S.page === 'team' || S.page === 'players') && (S.ui.scope === 'last4' || (S.page === 'team' && isUsage(b)) || (S.page === 'players' && S.ui.playersQuick))) jobs.push(loadL4(l4End()));
    if (S.page === 'team' && (isUsage(b)) && !(S.ros && S.rosFrom === Math.max(1, S.curWeek))) { S.rosLoading = true; jobs.push(loadRos().catch(() => {}).finally(() => { S.rosLoading = false; })); }

    if (S.page === 'players') jobs.push(loadSleeperAdp().catch(() => {}));
    await Promise.all(jobs);
    syncLineups();   // the week on screen may have changed while its matchups loaded
    // The week's plays are one 3 MB answer, fetched once and then kept. Home is
    // where people land, and Scoreboard is where they go next once a game has
    // kicked off — so start that fetch from Home, quietly, after the page is up.
    if (S.page === 'home' && !S.plays[w] && Object.values(S.kick || {}).some(k => k && (k.started || k.live || k.over))) {
        setTimeout(() => { if (!S.plays[w]) loadPlays(w).catch(() => {}); }, 2500);
    }
    if ((S.page === 'home' || S.page === 'team') && S.myRoster) { await loadNews(S.myRoster.players || []); }
}
function fail(e) {
    if (S.killed) return;   // already stepped aside; don't let stragglers write prefs
    console.error(TAG, e);
    S.errors.push(e && e.message || String(e));
    try { render(); } catch (e2) { console.error(TAG, 'render after error failed:', e2); showOriginal('Fantasy Badger could not render this page and stepped aside: ' + (e && e.message)); }
}
// `chosen` is someone picking Sleeper's layout from the switch: an ordinary
// thing to do, so it is noted quietly. Chrome lists every warning a page
// script logs under the extension's Errors, and a deliberate choice read
// there as a fault. Stepping aside after a failure still warns.
function showOriginal(reason, chosen) {
    try { localStorage.setItem('badgerLeagueUI', 'off'); } catch (e) {}
    if (root) root.remove();
    document.documentElement.classList.remove('badger-league-on');
    if (reason) (chosen ? console.info : console.warn)(TAG, reason);
}
// On Sleeper's own layout one thing of ours stays on the page: a button in the
// corner that brings Fantasy Badger back in one click, with the menu's other
// rows behind the arrow beside it. It sits on Sleeper's page, outside our
// shadow root, so it is plain DOM with its styles inline.
function injectOriginalPill() {
    if (document.getElementById('badger-league-pill')) return;
    const el = (tag, css, kids) => { const e = document.createElement(tag); e.style.cssText = css; for (const k of kids || []) e.append(k); return e; };
    const FACE = 'Nunito,system-ui,-apple-system,"Segoe UI",sans-serif';
    const ring = (b) => { b.addEventListener('focus', () => { b.style.outline = '2px solid #e6ebf2'; b.style.outlineOffset = '2px'; }); b.addEventListener('blur', () => { b.style.outline = 'none'; }); };
    const wrap = el('div', `position:fixed;top:10px;right:18px;z-index:2147483000;font:800 13px ${FACE};`);
    wrap.id = 'badger-league-pill';
    const mark = el('img', 'width:20px;height:20px;display:block;'); mark.src = BADGER_MARK; mark.alt = '';
    const back = el('button', 'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px 0 8px;border-radius:8px 0 0 8px;background:#20ceb8;color:#0d1117;cursor:pointer;white-space:nowrap;', [mark, 'Back to Fantasy Badger']);
    back.type = 'button'; back.dataset.act = 'badger-back'; back.title = 'Switch these pages back to Fantasy Badger’s layout'; ring(back);
    back.addEventListener('click', () => { try { localStorage.setItem('badgerLeagueUI', 'on'); } catch (e) {} location.reload(); });
    const tip = el('span', 'display:block;width:12px;height:7px;background:#e6ebf2;clip-path:polygon(0 0,100% 0,50% 100%);');
    const more = el('button', 'all:unset;box-sizing:border-box;display:inline-grid;place-items:center;width:34px;height:32px;border:1px solid #20ceb8;border-left:0;border-radius:0 8px 8px 0;background:#1a2030;cursor:pointer;', [tip]);
    more.type = 'button'; more.dataset.act = 'badger-menu'; more.title = 'Fantasy Badger: what’s new, feedback'; more.setAttribute('aria-label', more.title); more.setAttribute('aria-haspopup', 'true'); more.setAttribute('aria-expanded', 'false'); ring(more);
    const row = (href, title, under) => {
        const a = el('a', 'display:block;padding:8px 10px;border-radius:7px;color:#e6ebf2;text-decoration:none;cursor:pointer;', [
            el('span', `display:block;font:700 13px ${FACE};`, [title]), el('span', `display:block;font:600 12px ${FACE};color:#8591a7;`, [under])]);
        a.href = href; a.setAttribute('role', 'menuitem');
        a.addEventListener('mouseenter', () => { a.style.background = '#202737'; }); a.addEventListener('mouseleave', () => { a.style.background = 'none'; });
        return a;
    };
    // What's new is drawn by the league pages, so the row goes back to them with the notes open.
    const notes = row('#', 'What’s new', 'Opens in Fantasy Badger’s layout');
    notes.dataset.act = 'notes-open';
    notes.addEventListener('click', (e) => { e.preventDefault(); try { sessionStorage.setItem('badgerOpenNotes', '1'); localStorage.setItem('badgerLeagueUI', 'on'); } catch (err) {} location.reload(); });
    const say = row(feedbackHref('Sleeper’s own layout'), 'Send feedback', 'Opens an issue on GitHub'); say.target = '_blank'; say.rel = 'noopener';
    const menu = el('div', `display:none;position:absolute;top:40px;right:0;width:300px;box-sizing:border-box;background:#1a2030;border:1px solid #354060;border-radius:10px;box-shadow:0 16px 36px rgba(0,0,0,.5);padding:6px;text-align:left;`, [
        el('div', `display:flex;align-items:center;gap:9px;padding:8px 10px 9px;font:800 14px ${FACE};color:#e6ebf2;`, ['Fantasy Badger', el('span', 'margin-left:auto;font:600 11.5px ui-monospace,Menlo,monospace;color:#8591a7;', [fullVersion().split('.').slice(0, 3).join('.')])]),
        el('div', 'border-top:1px solid #2a3345;margin:0 0 4px;'), notes, say, el('div', 'border-top:1px solid #2a3345;margin:4px 0 0;'),
        el('div', `font:600 12px/1.4 ${FACE};color:#8591a7;padding:8px 10px;`, ['To take this button off Sleeper as well, switch Fantasy Badger off from its icon in Chrome’s toolbar.'])]);
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Fantasy Badger');
    const set = (open) => { menu.style.display = open ? 'block' : 'none'; more.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    more.addEventListener('click', (e) => { e.stopPropagation(); set(menu.style.display === 'none'); });
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => set(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
    wrap.append(el('div', 'display:inline-flex;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);', [back, more]), menu);
    document.body.appendChild(wrap);
}
// The page's two faces ship in the package (fonts/, SIL Open Font License, the
// licences beside them), so drawing the page asks nothing of any host. They are
// declared on the document, not in the shadow root, which does not honour
// @font-face. Latin and Latin Extended: player names carry their accents.
const FONT_FACES = [
    ['IBM Plex Mono', '400', 'ibm-plex-mono-400-latin-ext.woff2', 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'],
    ['IBM Plex Mono', '400', 'ibm-plex-mono-400-latin.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
    ['IBM Plex Mono', '600', 'ibm-plex-mono-600-latin-ext.woff2', 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'],
    ['IBM Plex Mono', '600', 'ibm-plex-mono-600-latin.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
    ['Nunito', '600 800', 'nunito-latin-ext.woff2', 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'],
    ['Nunito', '600 800', 'nunito-latin.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
];
function fontFaces() {
    return FONT_FACES.map(([fam, w, file, range]) => `@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};font-display:swap;src:url(${chrome.runtime.getURL('fonts/' + file)}) format('woff2');unicode-range:${range};}`).join('');
}
function mount() {
    root = document.createElement('div');
    root.id = 'badger-league';
    root.style.cssText = 'position:fixed;inset:0;overflow:auto;z-index:2147482000;background:#0f131b;';
    shadow = root.attachShadow({ mode: 'open' });
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = chrome.runtime.getURL('league.css');
    if (!document.getElementById('badger-fonts')) { const faces = document.createElement('style'); faces.id = 'badger-fonts'; faces.textContent = fontFaces(); document.head.appendChild(faces); }
    app = h('div', { class: 'bl' }, h('div', { class: 'loading' },
        h('div', { class: 'badgerload' }, h('span', { class: 'ring' }), h('img', { src: chrome.runtime.getURL('icons/badger-mascot-128.png'), alt: '' })),
        h('div', null, 'Loading your league…')));
    layer = h('div', { class: 'bl', style: 'min-height:0;background:transparent;position:static;width:auto;' });
    shadow.append(link, app, layer);
    wireTips();
    document.documentElement.classList.add('badger-league-on');
    document.body.appendChild(root);
    const style = document.createElement('style');
    style.textContent = '.badger-league-on #root { visibility: hidden !important; } .badger-league-on { overflow: hidden !important; }';
    document.head.appendChild(style);
}

async function boot() {
    const r = parseRoute();
    if (!r) return;
    // The toolbar switch (popup.html): off means Fantasy Badger does not run on
    // Sleeper at all — no layout, no pill — until it is switched back on.
    try { if ((await chrome.storage.local.get('badgerOff')).badgerOff) { console.info(TAG, 'switched off in the toolbar: Sleeper’s own page'); return; } } catch (e) { /* storage unreadable: run */ }
    let pref = 'on'; try { pref = localStorage.getItem('badgerLeagueUI') || 'on'; } catch (e) {}
    if (pref === 'off') { injectOriginalPill(); return; }
    S.leagueId = r.leagueId; S.page = r.page;

    mount();
    try {
        await Promise.all([loadCore(), loadPlayers()]);
        await loadSchedule();   // needs the season from loadCore
        if (!settleWeek() && S.seasonType === 'regular') S.week = defaultWeek(S.page);
        await ensureData();
        render();
        try { if (sessionStorage.getItem('badgerOpenNotes')) { sessionStorage.removeItem('badgerOpenNotes'); openNotes(); } } catch (e) { /* no storage: the notes stay a click away */ }
        console.log(TAG, `up: ${S.league.name}, week ${S.week} (${S.seasonType}), me=${S.myRoster ? 'roster ' + S.myRoster.roster_id : 'no roster'}`);
        loadMessages().then(() => { if (S.ui.chat) render(); });
        loadSeasonChain();
        // The league moves without you: other managers add, drop and trade.
        // Refresh the shared state every minute and whenever the tab comes
        // back into focus, so Available means available NOW.
        const refreshShared = async () => {
            if (S.killed || contextGone()) { if (!S.killed) orphaned(); return; }
            try {
                const rosters = await rest(`${API}/league/${S.leagueId}/rosters`);
                S.rosters = rosters;
                S.myRoster = rosters.find(r => String(r.owner_id) === String(S.myUserId) || (r.co_owners || []).map(String).includes(String(S.myUserId))) || S.myRoster;
                S.matchups[S.week] = null; S.legs[S.week] = null; S.txns[S.week] = null; S.waivers = null;
                await Promise.all([loadMatchups(S.week), loadLegs(S.week), loadTxns(S.week), loadPending(), loadWaivers(), refreshLive(), loadMessages(), loadDms(), reloadLineups()]);
                syncLineups();
                render();
            } catch (e) { console.warn(TAG, 'refresh:', e.message); }
        };
        wsConnect();
        // The poll is now the safety net rather than the mechanism: every minute
        // while the socket is down or silent, every five while it is carrying.
        let lastPoll = Date.now();
        setInterval(() => {
            if (document.hidden || S.killed) return;
            if (standingsDue()) refreshStandings().then((moved) => { if (moved && !S.killed) render(); });
            const carried = wsHealthy() && wsLastPush && Date.now() - wsLastPush < 120000;
            if (Date.now() - lastPoll < (carried ? 300000 : 60000)) return;
            lastPoll = Date.now(); refreshShared();
        }, 15000);
        // The open conversation is re-read every 20 seconds while the drawer is
        // open: the socket carries messages when it is healthy, and this is what
        // holds when it is not. Reactions from others only arrive this way.
        setInterval(() => {
            if (document.hidden || !S.ui.chat || S.killed) return;
            const cid = convoId();
            loadConvo(cid).then(() => { if (S.ui.chat && convoId() === cid) render(); });
        }, 20000);
        // Putting focus back by script draws the focus ring, which is right for
        // someone moving by keyboard and a box around the thing just clicked
        // for someone using a mouse. A field being typed in always keeps it.
        window.addEventListener('keydown', () => { kbdNav = true; }, true);
        window.addEventListener('pointerdown', () => { kbdNav = false; }, true);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            if (!wsHealthy()) { wsRetry = 0; wsConnect(); }
            lastPoll = Date.now(); refreshShared();
        });
        window.badgerLedger = () => { S.ledgerForce = true; S.ui.homeBot = 'ledger'; go('home'); return 'ledger preview on'; };
        // Debug handles, reachable from the extension's own console context:
        // badgerLeagueS is the live state, badgerRender redraws after poking it.
        window.badgerLeagueS = S; window.badgerRender = render;
        window.badgerLeagueWs = () => ({ open: wsHealthy(), applied: wsApplied, lastMessage: wsLastMsg ? new Date(wsLastMsg).toISOString() : null, lastPush: wsLastPush ? new Date(wsLastPush).toISOString() : null, pollCadence: (wsHealthy() && wsLastPush && Date.now() - wsLastPush < 120000) ? '5m (socket carrying)' : '60s (socket quiet)', frames: WS_LOG.slice() });
    } catch (e) {
        if (!S.killed) {
            console.error(TAG, 'boot failed:', e);
            showOriginal('boot failed: ' + (e && e.message));
            injectOriginalPill();
        }
    }
    // the curve's panes borrow the score bug's box widths, which move with the window
    let rsT = null; window.addEventListener('resize', () => { syncBar(); clearTimeout(rsT); rsT = setTimeout(syncPanes, 120); });
    window.addEventListener('popstate', () => { const r2 = parseRoute(); if (r2 && r2.leagueId === S.leagueId) { S.page = r2.page; if (S.ui.weekPicked) leavePick(r2.page); render(); ensureData().then(render).catch(fail); } });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && S.ui.report) { S.ui.report = null; render(); return; }
        if (e.key === 'Escape') { if (S.ui.sel) { S.ui.sel = null; S.ui.dropAsk = null; render(); return; }   // the player card sits over the drawer: it goes first
            if (S.ui.tx || S.ui.notes || S.ui.chat || S.ui.menu || S.ui.muPick || S.ui.composer || S.ui.trade || S.ui.pdOpen || S.ui.wkOpen || S.ui.teamMenu || S.ui.moreOpen || S.ui.vault || S.ui.bmenu) { S.ui.bmenu = false; S.ui.tx = null; S.ui.notes = false; S.ui.moreOpen = false; S.ui.chat = false; S.ui.vault = null; S.ui.menu = false; S.ui.muPick = false; S.ui.composer = null; S.ui.sel = null; S.ui.dropAsk = null; S.ui.trade = null; S.ui.pdOpen = false; S.ui.wkOpen = false; S.ui.teamMenu = false; S.ui.dropOpen = false; render(); } }
        if (e.key === '/' && S.page === 'players' && !/input|textarea/i.test((e.composedPath()[0] || {}).tagName)) { e.preventDefault(); const i = $('.search input'); if (i) i.focus(); }
    });
}

// ── render: frame ────────────────────────────────────────────────────────────
// The extension was reloaded or updated under an open tab: this copy of the page
// script can no longer reach chrome.*, and every call throws "Extension context
// invalidated" (a minute's refresh, a push from the socket, a click). It stands
// down, quietly, and offers the reload that brings in the new copy.
function contextGone() { try { return !chrome.runtime || !chrome.runtime.id; } catch (e) { return true; } }
function orphaned() {
    if (S.orphaned) return;
    S.orphaned = true; S.killed = true;
    console.info(TAG, 'the extension was updated under this tab: standing down until it is reloaded');
    if (!layer) return;
    const old = $('.toast'); if (old) old.remove();
    layer.appendChild(h('div', { class: 'toast ok orphan' }, 'Fantasy Badger was updated. ',
        h('button', { class: 'btn sm', type: 'button', onclick: () => location.reload() }, 'Reload this tab')));
}
function render() {
    if (!S.orphaned && contextGone()) orphaned();
    if (S.killed) return;
    if (!app) return;
    if (S.ui && S.ui.nickEdit && S.ui.sel !== S.ui.nickEdit.pid) S.ui.nickEdit = null;   // a nickname half-typed goes with its card
    // Nothing to draw before the league is in hand. An early caller — anything
    // landing before loadCore — used to wipe the loading
    // screen and throw in topbar reading a league that was still null.
    if (!S.league) return;
    const scrollY = root.scrollTop;
    // the header it was pointing at is about to be rebuilt; on a live Sunday that
    // is every few seconds, so the tooltip comes back on the rebuilt header if
    // the pointer is still on it
    const tipWas = tipFor ? { tip: tipFor.dataset.tip, pos: tipFor.dataset.pos, cell: tipFor.dataset.say != null } : null;
    tipHide();
    // Inner scroll containers are rebuilt on every render; remember where they were.
    // Both axes. Only scrollTop was kept, so sorting the Players table — a
    // full re-render — threw away the horizontal scroll and slid the column you
    // had just clicked back off the right-hand edge.
    const kept = {}; for (const el of $$('[data-keep]')) kept[el.dataset.keep] = { top: el.scrollTop, left: el.scrollLeft };
    // A field marked data-focus keeps focus and caret through the rebuild: with
    // messages arriving by push, the composer is rebuilt while you type.
    const act = shadow.activeElement, focusKey = act && act.dataset ? act.dataset.focus : null;
    const caret = focusKey && typeof act.selectionStart === 'number' ? [act.selectionStart, act.selectionEnd] : null;
    app.innerHTML = '';
    app.append(topbar());
    app.addEventListener('click', () => { if (S.ui.pdOpen || S.ui.wkOpen || S.ui.teamMenu || S.ui.dropOpen || S.ui.moreOpen || S.ui.bmenu) { S.ui.bmenu = false; S.ui.pdOpen = false; S.ui.wkOpen = false; S.ui.teamMenu = false; S.ui.dropOpen = false; S.ui.moreOpen = false; render(); } }, { once: true });
    const err = S.errors.length ? h('div', { class: 'card', style: 'margin:14px 18px 0;border-color:#ef5a5a;color:#ef5a5a;font-weight:700;' }, `Something did not load: ${S.errors[S.errors.length - 1]}`, ' ', h('button', { class: 'btn sm', style: 'margin-left:8px', onclick: () => { S.errors = []; render(); } }, 'Dismiss')) : null;
    if (err) app.append(err);
    const pageEl = S.ui.vault ? vaultPage : ({ home: pageHome, team: pageTeam, players: pagePlayers, matchup: pageMatchup, league: pageLeague }[S.page] || pageHome);
    try { const pg = pageEl(); app.append(pg); addCopyButtons(pg); fitGauges(pg); } catch (e) { console.error(TAG, 'page render:', e); app.append(h('div', { class: 'card', style: 'margin:18px' }, 'This page hit an error: ', e.message)); }
    if (S.ui.tx) { try { const d = txDrawer(); if (d) app.append(d); } catch (e) { console.error(TAG, 'transactions:', e); } S.ui.chatView = null; }
    else if (S.ui.notes) { app.append(notesDrawer()); S.ui.chatView = null; }
    else if (S.ui.chat) app.append(chatDrawer()); else S.ui.chatView = null;
    if (S.ui.report) { try { app.append(reportModal(S.ui.report)); } catch (e) { console.error(TAG, 'report:', e); S.ui.report = null; } }
    if (S.ui.sel) app.append(playerModal(S.ui.sel));
    root.scrollTop = scrollY;
    for (const el of $$('[data-keep]')) { const k = kept[el.dataset.keep]; if (k) { el.scrollTop = k.top; el.scrollLeft = k.left; } }
    if (focusKey && (caret || kbdNav)) { const el = $(`[data-focus="${focusKey}"]`); if (el) { el.focus({ preventScroll: true }); if (caret && typeof el.setSelectionRange === 'function') try { el.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ } } }
    if (tipWas && tipX >= 0) { const under = shadow.elementFromPoint(tipX, tipY), again = under && under.closest ? under.closest('[data-tip], [data-say]') : null; if (again && (tipWas.cell ? again.dataset.say != null : again.dataset.tip === tipWas.tip)) tipShow(again); }
    syncBar();
    syncPanes();
}
function topbar() {
    const L = S.league, my = S.myRoster;
    const needs = my ? lineupIssues(my).length : 0;
    const pendingMine = S.pending.filter(t => t.type === 'trade' && (t.roster_ids || []).includes(my && my.roster_id) && String(t.creator) !== String(S.myUserId)).length;
    // The week is picked on the pages that are about one, so the league's line
    // names its shape, and the part of the year only when that is not the season.
    const sub = `${L.settings.num_teams}-team · ${scoringLabel()}${S.seasonType === 'regular' ? '' : ' · ' + (S.seasonType === 'pre' ? 'Preseason' : S.seasonType)}`;
    const brand = h('div', { class: 'brand', onclick: (e) => { e.stopPropagation(); S.ui.bmenu = false; S.ui.menu = !S.ui.menu; render(); } },
        h('div', { class: 'lg' }, L.avatar ? h('img', { src: avatarUrl(L.avatar), alt: '' }) : '🏈'),
        h('div', { class: 'bn' }, h('span', { class: 'bname', title: L.name }, L.name), h('small', null, sub)),
        caret('caret'),
        S.ui.menu ? leagueMenu() : null);
    // The pages: five words. Scoreboard says LIVE while NFL games are being played,
    // the same mark a matchup under way carries.
    const liveN = S.seasonType === 'regular' ? gamesLiveNow() : 0;
    const nav = h('nav', { class: 'nav' }, ...[['home', 'Home'], ['team', 'Team'], ['players', 'Players'], ['matchup', 'Scoreboard'], ['league', 'League']].map(([k, t]) =>
        h('a', { class: k === S.page ? 'on' : '', onclick: () => go(k) }, t, k === 'team' && (needs + pendingMine) ? h('span', { class: 'cnt' }, needs + pendingMine) : null,
            k === 'matchup' && liveN ? h('span', { class: 'navlive', title: `${liveN} game${liveN === 1 ? '' : 's'} in progress` }, h('i', { 'aria-hidden': 'true' }), 'LIVE') : null)));
    // What opens a drawer sits together on the right, each with its word: a
    // drawer is not a page, and nothing in the bar is a symbol on its own.
    const txBtn = () => {
        if (!my) return null;
        const n = inFlightCount(), runs = waiverRuns(), fresh = !!runs.length && runs[0].at > txSeenAt();
        const t = `Transactions · ${n ? `${n} in flight for your team` : 'claims, trades and waiver results'}${fresh ? ' · a waiver run was processed' : ''}`;
        return h('button', { class: `tool tx${n ? ' hot' : ''}${S.ui.tx ? ' open' : ''}`, title: t, 'aria-label': t, 'data-act': 'tx-open', onclick: () => { if (S.ui.tx) closeTx(); else openTx(); } },
            svgIcon('moves'), h('span', { class: 'lbl' }, 'Transactions'), n ? h('span', { class: 'cnt' }, String(n)) : fresh ? h('span', { class: 'txrundot', 'aria-hidden': 'true' }) : null);
    };
    const nLeague = leagueUnread(), nDm = unreadDms(), unread = nLeague + nDm;
    const chatTitle = unread ? `Chat · ${[nLeague ? `${nLeague} new in the league` : null, nDm ? `${nDm} unread direct message${nDm === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}` : 'League chat and messages';
    const chatBtn = h('button', { class: `tool chat${S.ui.chat ? ' open' : ''}`, title: chatTitle, 'aria-label': chatTitle, 'data-act': 'chat-open',
        onclick: () => { S.ui.chat = !S.ui.chat; if (S.ui.chat) { S.ui.tx = null; S.ui.notes = false; S.ui.composer = null; S.ui.trade = null; } render(); if (S.ui.chat) loadConvo(convoId()).then(render); } },
        svgIcon('chat'), h('span', { class: 'lbl' }, 'Chat'), unread && !S.ui.chat ? h('span', { class: 'cnt chatcnt' }, unread > 9 ? '9+' : String(unread)) : null);
    return h('div', { class: 'topbar', onclick: () => { if (S.ui.menu || S.ui.bmenu) { S.ui.menu = false; S.ui.bmenu = false; render(); } } },
        brand, nav, h('div', { class: 'icons' }, txBtn(), chatBtn, badgerOpener()));
}
// The brand menu is a league switcher: every league this account is in this
// season, the current one marked, one click to jump.
function leagueMenu() {
    if (S.myLeagues === undefined) { S.myLeagues = null; rest(`${API}/user/${S.myUserId}/leagues/nfl/${S.season}`).then(ls => { S.myLeagues = ls || []; render(); }).catch(() => { S.myLeagues = []; }); }
    const ls = S.myLeagues;
    // Where you stand in each league: your team, record and place. This
    // league's comes from what is loaded; the others are read once.
    S.leagueStand = S.leagueStand || {};
    const standOf = (L) => {
        const id = String(L.league_id);
        if (id === String(S.leagueId) && S.myRoster) {
            const rank = rosterRank().findIndex(r => r.roster_id === S.myRoster.roster_id) + 1;
            return { team: teamName(S.myRoster), rec: record(S.myRoster), place: rank, n: S.rosters.length };
        }
        if (S.leagueStand[id] === undefined) {
            S.leagueStand[id] = null;
            Promise.all([rest(`${API}/league/${id}/rosters`), rest(`${API}/league/${id}/users`)]).then(([rs, us]) => {
                const mine = rs.find(r => String(r.owner_id) === String(S.myUserId) || (r.co_owners || []).map(String).includes(String(S.myUserId)));
                if (!mine) { S.leagueStand[id] = false; render(); return; }
                const pts = (r) => (r.settings.fpts || 0) + (r.settings.fpts_decimal || 0) / 100;
                const order = rs.slice().sort((a, b) => (b.settings.wins - a.settings.wins) || (pts(b) - pts(a)));
                const u = us.find(x => String(x.user_id) === String(S.myUserId)) || {};
                const st = mine.settings;
                S.leagueStand[id] = { team: ((u.metadata || {}).team_name || '').trim() || u.display_name || 'Your team', rec: `${st.wins}–${st.losses}${st.ties ? '–' + st.ties : ''}`, place: order.indexOf(mine) + 1, n: rs.length };
                render();
            }).catch(() => { S.leagueStand[id] = false; });
        }
        return S.leagueStand[id];
    };
    const ord = (n) => { const v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); };
    const m = h('div', { class: 'menu lmenu', onclick: (e) => e.stopPropagation() }, h('div', { class: 'lmhd' }, 'YOUR LEAGUES'));
    if (!ls) m.append(h('div', { class: 'dim', style: 'padding:6px 10px 8px;font-size:12px' }, h('span', { class: 'spin' }), 'Your leagues…'));
    for (const L of (ls || [])) {
        const on = String(L.league_id) === String(S.leagueId);
        const sd = standOf(L);
        const sub = L.status === 'pre_draft' || L.status === 'drafting' ? h('span', { class: 'rc' }, L.status === 'drafting' ? 'drafting now' : 'draft to come')
            : sd ? [h('span', { class: 'tn' }, sd.team), h('span', { class: 'rc' }, `${sd.rec} · ${ord(sd.place)} of ${sd.n}`)]
            : h('span', { class: 'rc' }, sd === false ? `${(L.settings || {}).num_teams || '?'}-team` : '…');
        m.append(h('a', { class: `lmrow ${on ? 'on' : ''}`.trim(), href: `/leagues/${L.league_id}`, 'aria-current': on ? 'true' : null, onclick: (e) => { e.preventDefault(); if (on) { S.ui.menu = false; render(); return; } try { sessionStorage.setItem('badgerLeaguePage-' + L.league_id, S.page); sessionStorage.setItem('badgerLeagueSeen-' + L.league_id, '1'); } catch (err) {} location.href = `/leagues/${L.league_id}/${S.page === 'home' ? 'matchup' : S.page}#/${S.page}`; } },
            h('div', { class: 'avatar sm' }, L.avatar ? h('img', { src: avatarUrl(L.avatar), alt: '' }) : '🏈'),
            h('div', { class: 'lmw' }, h('div', { class: 'lmnm' }, L.name), h('div', { class: 'lmsub' }, sub)),
            on ? h('span', { class: 'lmck', title: 'You are here' }, '✓') : null));
    }
    if ((S.chain || []).length) {
        m.append(h('div', { class: 'sep' }), h('div', { class: 'lmhd' }, `${S.league.name} · PAST SEASONS`.toUpperCase()),
            ...S.chain.map(c => h('a', { class: 'lmrow lmpast', onclick: (e) => { e.preventDefault(); vaultOpen(c.id); } },
                h('span', { class: 'yr' }, String(c.season)), h('span', { 'aria-hidden': 'true' }, '\u{1F3C6}'),
                h('span', { class: 'ch' }, c.champ ? `${c.champ}, champion` : 'season'), h('span', { class: 'chev' }, '›'))));
    }
    return m;
}
// ── what's new ───────────────────────────────────────────────────────────────
// The notes ship in the package (changelog.js). An update to a new minor sets a
// flag (background.js); it shows as a dot on the Badger button, and as NEW in
// its menu, until the notes are opened.
// The version is the date and the time of day (scripts/stamp-version.sh); the
// notes are keyed by the date, its first three numbers.
const notesVersion = () => chrome.runtime.getManifest().version.split('.').slice(0, 3).join('.');
function notesUnread() {
    if (S.notesUnread === undefined) {
        S.notesUnread = false;
        try { chrome.storage.local.get('badgerNotesUnread').then(r => { if (r && r.badgerNotesUnread) { S.notesUnread = true; render(); } }).catch(() => {}); } catch (e) { /* no storage: no dot */ }
    }
    return S.notesUnread;
}
function openNotes() {
    S.ui.menu = false; S.ui.bmenu = false; S.ui.tx = null; S.ui.chat = false; S.ui.composer = null; S.ui.trade = null;
    S.ui.notes = true; S.ui.notesOpen = S.ui.notesOpen || {};
    if (S.notesUnread) { S.notesUnread = false; try { chrome.storage.local.remove('badgerNotesUnread'); } catch (e) { /* the dot comes back next load */ } }
    render();
}
function notesDrawer() {
    const cur = notesVersion();
    const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || (x[2] || 0) - (y[2] || 0); };
    const list = (globalThis.BADGER_NOTES || []).filter(n => newer(n.v, cur) <= 0);
    const open = S.ui.notesOpen || (S.ui.notesOpen = {});
    const html = (s2) => { const d = h('span'); d.innerHTML = s2; return d; };   // our own text, from the package
    const entry = (n, i) => {
        const isOpen = i === 0 || !!open[n.v];
        const head = h('div', { class: 'wnvh' }, h('b', null, n.when), i === 0 ? h('span', { class: 'wnnew' }, 'CURRENT') : foldCaret(isOpen, 'wnchev'));
        return h('section', { class: `wnv ${isOpen ? 'open' : ''}`.trim() },
            i === 0 ? head : h('button', { class: 'wnhbtn', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { open[n.v] = !open[n.v]; render(); } }, head),
            h('div', { class: 'wnt' }, n.title),
            isOpen ? h('ul', null, ...n.items.map(t => h('li', null, html(t)))) : null);
    };
    return h('div', { class: 'drawer wnd', style: 'width:420px', role: 'dialog', 'aria-label': 'What’s new' },
        h('div', { class: 'dh' }, h('span', null, 'What’s new'), h('span', { style: 'flex:1' }), h('button', { class: 'btn sm s', onclick: () => { S.ui.notes = false; render(); } }, 'Close · Esc')),
        h('div', { class: 'db' }, ...(list.length ? list.map(entry) : [h('div', { class: 'dim' }, 'No notes for this version yet.')]),
            list.length > 1 ? h('div', { class: 'wnfoot' }, 'Earlier versions open with a click.') : null));
}
// ── the Badger menu ──────────────────────────────────────────────────────────
// Everything about Fantasy Badger itself sits behind one button in the corner:
// which layout the league pages wear, what the last update brought, and where
// to say something about it. The league field beside the pages stays what it
// was, the leagues.
//
// Where the menu's links lead. Each opens in a new tab on a click; none is fetched.
const LINKS = { privacy: 'https://fantasybadger.com/privacy/extension', store: 'https://chromewebstore.google.com/detail/', source: 'https://github.com/FantasyBadger/fantasy-badger-sleeper-extension' };
const BADGER_MARK = (() => { try { return chrome.runtime.getURL('icons/badger-mascot-128.png'); } catch (e) { return ''; } })();
const fullVersion = () => { try { const m = chrome.runtime.getManifest(); return m.version_name || m.version; } catch (e) { return ''; } };
// Feedback is an issue on the repository. The form opens with the version and the
// page already written in, and nothing about the league: what else goes in is the
// writer's to add.
const feedbackHref = (where) => `${LINKS.source}/issues/new?body=${encodeURIComponent(`Version: ${fullVersion()}\nPage: ${where}\n\nWhat happened, or what you would like:\n`)}`;
// The listing exists only for a copy that came from the store.
const storeListing = () => { try { return 'update_url' in chrome.runtime.getManifest() ? LINKS.store + chrome.runtime.id : null; } catch (e) { return null; } };
// The notes the installed version carries, newest first, as What's new lists them.
const notesShown = () => { const cur = notesVersion().split('.').map(Number); return (globalThis.BADGER_NOTES || []).filter(n => { const v = String(n.v).split('.').map(Number); return (v[0] - cur[0] || v[1] - cur[1] || (v[2] || 0) - (cur[2] || 0)) <= 0; }); };
// The badger keeps its own colours on a teal ground: on the dark bar it is too dark to read alone.
const badgerChip = (px) => h('span', { class: 'bchip', style: `width:${px}px;height:${px}px`, 'aria-hidden': 'true' }, h('img', { src: BADGER_MARK, alt: '', style: `width:${px - 6}px;height:${px - 6}px` }));
function badgerOpener() {
    const unread = notesUnread();
    const t = unread ? 'Fantasy Badger was updated: What’s new is in this menu' : 'Fantasy Badger: layout, what’s new, feedback';
    return h('div', { class: 'bwrap', onclick: (e) => e.stopPropagation() },
        h('button', { class: `opener${S.ui.bmenu ? ' open' : ''}`, 'aria-haspopup': 'true', 'aria-expanded': S.ui.bmenu ? 'true' : 'false', title: t, 'aria-label': t, 'data-act': 'badger-menu',
            onclick: () => { S.ui.menu = false; S.ui.bmenu = !S.ui.bmenu; render(); } },
            badgerChip(22), h('span', { class: 'lbl' }, 'Badger'), caret(), unread ? h('span', { class: 'udot', 'aria-hidden': 'true' }) : null),
        S.ui.bmenu ? badgerMenu() : null);
}
function badgerMenu() {
    const unread = notesUnread(), top = notesShown()[0], shop = storeListing();
    const shut = () => setTimeout(() => { S.ui.bmenu = false; render(); }, 0);   // after the click has done its own work
    const out = (href) => ({ href, target: '_blank', rel: 'noopener', onclick: shut });
    const row = (attrs, title, under, right) => h('a', Object.assign({ role: 'menuitem' }, attrs), h('span', { class: 'bmt' }, h('b', null, title), under ? h('small', null, under) : null), right || null);
    return h('div', { class: 'menu bmenu', role: 'menu', 'aria-label': 'Fantasy Badger' },
        h('div', { class: 'bmhead' }, badgerChip(28), h('b', null, 'Fantasy Badger'), h('span', { class: 'bmver' }, notesVersion())),
        h('div', { class: 'sep' }),
        h('div', { class: 'bmhd' }, 'LAYOUT'),
        layoutSwitch(),
        h('p', { class: 'bmnote' }, 'On Sleeper’s own pages a Badger button stays in this corner, so coming back is one click.'),
        h('div', { class: 'sep' }),
        row({ class: `bmrow${unread ? ' hi' : ''}`, href: '#', 'data-act': 'notes-open', onclick: (e) => { e.preventDefault(); openNotes(); } },
            ['What’s new', top ? h('span', { class: 'bmstamp' }, ` · ${String(top.when).replace(/,\s*\d{4}$/, '')}`) : null], top ? top.title : null,
            unread ? h('span', { class: 'bmnew' }, 'NEW') : null),
        row(Object.assign({ class: 'bmrow' }, out(feedbackHref({ home: 'Home', team: 'Team', players: 'Players', matchup: 'Scoreboard', league: 'League' }[S.page] || S.page))), 'Send feedback', 'Opens an issue on GitHub', svgIcon('out', 'bmout')),
        h('div', { class: 'sep' }),
        h('div', { class: 'bmfoot' }, h('a', out(LINKS.privacy), 'Privacy policy'), h('a', out(LINKS.source), 'Source code'), shop ? h('a', out(shop), 'Rate it on the store') : null));
}
// ── the layout switch ────────────────────────────────────────────────────────
// Badger | Sleeper, with the one you are on lit. It is drawn in the Badger
// menu, so Badger's half is always the lit one; Sleeper's half reloads the page
// as Sleeper drew it.
function layoutSwitch() {
    // Sleeper's mark: the left of its own nav logo, which carries the wordmark beside it
    const sleeper = h('span', { class: 'smark', 'aria-hidden': 'true' });
    return h('div', { class: 'ltog', role: 'group', 'aria-label': 'Page layout' },
        h('button', { type: 'button', class: 'lit', 'aria-pressed': 'true', title: 'You are on Fantasy Badger’s layout' }, h('img', { src: BADGER_MARK, alt: '' }), 'BADGER'),
        h('button', { type: 'button', 'aria-pressed': 'false', title: 'Switch to Sleeper’s own layout', 'data-act': 'layout-sleeper',
            onclick: () => { showOriginal('user chose Sleeper’s layout', true); location.reload(); } }, sleeper, 'SLEEPER'));
}
function showOriginalNav(path) { try { localStorage.setItem('badgerLeagueUI', 'off'); } catch (e) {} location.href = path; }
function scoringLabel() { const sc = (S.league.scoring_settings || {}); const r = sc.rec || 0; return r === 1 ? 'PPR' : r === 0.5 ? 'Half PPR' : r === 0 ? 'Standard' : `${r} PPR`; }
function setWeek(w) { S.ui.weekPicked = true; S.week = Math.max(1, Math.min(18, w)); syncLineups(); render(); ensureData().then(render).catch(fail); }
// The week picker: the control that answers "when" on a page that is about one
// week. Weeks of the live season, and — since a past season is also a when —
// the archive at the foot of the same list. A past season, once open, walks
// its own weeks on its own page.
// A week list that opens on the week you are looking at. scrollTop rather than
// scrollIntoView: the latter would scroll the page behind the menu too.
function pdScroll(rows) {
    const el = h('div', { class: 'pdscroll' }, ...rows);
    setTimeout(() => { const on = el.querySelector('.mi.on'), top = on ? on.offsetTop - el.offsetTop : 0;   // its place in this list, not in the whole menu
        if (on && top + on.offsetHeight > el.clientHeight) el.scrollTop = top - el.clientHeight / 2 + on.offsetHeight / 2; }, 0);
    return el;
}
function weekDropdown() {
    const ui = S.ui;
    const mi = (txt, sub, on, disabled, fn) => h('div', { class: `mi ${on ? 'on' : ''} ${disabled ? 'off' : ''}`, onclick: disabled ? null : fn }, txt, h('span', { class: 'mono' }, sub || ''));
    // Past seasons, at the foot of the menu. Opening one is a mode change, not a
    // scrub, so they are separated and carry the champion rather than a week.
    const seasonRows = (S.chain || []).map(c =>
        h('div', { class: 'mi sea', onclick: () => { ui.wkOpen = false; vaultOpen(c.id); } },
            h('span', null, h('span', { class: 'tro' }, '\u{1F3C6}'), `${c.season} season`),
            h('span', { class: 'mono' }, c.champ ? String(c.champ).slice(0, 11) : '→')));
    const pick = (w) => { ui.wkOpen = false; setWeek(w); };
    const inSeason = S.seasonType === 'regular';
    const menu = ui.wkOpen ? h('div', { class: 'pdmenu', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'pdpin' },
            mi('Last week', S.curWeek > 1 && inSeason ? `wk ${S.curWeek - 1}` : '—', S.week === S.curWeek - 1, !(S.curWeek > 1 && inSeason), () => pick(S.curWeek - 1)),
            mi('Current week', `wk ${S.curWeek}`, S.week === S.curWeek, false, () => pick(S.curWeek)),
            mi('Next week', S.curWeek < LAST_WEEK ? `wk ${S.curWeek + 1}` : '—', S.week === S.curWeek + 1, !(S.curWeek < LAST_WEEK), () => pick(S.curWeek + 1))),
        h('div', { class: 'pdhd' }, 'ALL WEEKS'),
        pdScroll(Array.from({ length: LAST_WEEK }, (_, i) => i + 1).map(w => mi(`Week ${w}`, w === S.curWeek ? 'current' : '', S.week === w, false, () => pick(w)))),
        seasonRows.length ? h('div', { class: 'pdhd tp' }, 'PAST SEASONS') : null,
        ...seasonRows) : null;
    return h('div', { class: 'pdd', onclick: (e) => e.stopPropagation() },
        h('button', { class: 'ddbtn', style: S.week !== S.curWeek ? 'color:var(--amber)' : '', title: S.week === S.curWeek ? 'Current week' : `Viewing week ${S.week} — current is ${S.curWeek}`, onclick: () => { ui.wkOpen = !ui.wkOpen; render(); } },
            `Week ${S.week}${S.week === S.curWeek ? ' · current' : ''}`, caret()), menu);
}
// The picker with ‹ › either side, as the Team and Players rows carry theirs:
// stepping one week is the commonest move.
function weekControl() {
    const arrow = (d, glyph, title) => h('button', { class: 'pstep', disabled: S.week + d < 1 || S.week + d > LAST_WEEK, title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); setWeek(S.week + d); } }, glyph);
    return h('div', { class: 'wkc' }, arrow(-1, '‹', 'Previous week'), weekDropdown(), arrow(1, '›', 'Next week'));
}

// ── roster insights ──────────────────────────────────────────────────────────
// One verdict per roster row (empty slot, won't play, out-projected, Q-with-
// late-cover, IR candidate, bench-beats, bye-next-week), worked out here from
// Sleeper's numbers.
const INS_POS = { QB: 1, RB: 1, WR: 1, TE: 1, K: 1, DEF: 1 };
const INS_NO_PLAY = /^(out|ir|pup|sus|cov|dnr|na)$/;
const INS_MAYBE = /^(questionable|doubtful)$/;
function insNormStatus(s) {
    if (!s) return null; const x = String(s).toLowerCase();
    if (/^q/.test(x)) return 'Questionable';
    if (/^doub/.test(x)) return 'Doubtful';
    if (/out/.test(x)) return 'Out';
    if (/pup/.test(x)) return 'PUP';
    if (/sus/.test(x)) return 'SUS';
    if (/cov/.test(x)) return 'COV';
    if (/dnr/.test(x)) return 'DNR';
    if (/^ir$/.test(x)) return 'IR';
    if (/^na$/.test(x)) return 'NA';
    return null;
}
// S.kick holds one week's games. On the Scoreboard the week on screen is often
// last week (the review week) while the map still holds this week's, and reading
// across the two told a finished week it had players still to play: every tile
// on a settled week read "IN PLAY · 1 still to play".
const kickMap = () => (S.kick && S.kickWeek === S.week) ? S.kick : null;
function insKickInfo(pid) { const pl = P(pid); const m = kickMap(); return (pl && pl.team && m && m[pl.team]) || null; }
function insPlayer(pid, where, slotIndex) {
    if (!P(pid) || !INS_POS[ppos(pid)]) return null;
    const k = insKickInfo(pid);
    const p = {
        ref: String(pid), name: pname(pid), pos: ppos(pid), where,
        proj: projOf(pid, S.week) || 0,
        status: insNormStatus(statusOf(pid)),
        on_bye: isBye(pid, S.week), bye_next_week: isBye(pid, S.week + 1),
        kickoff: k ? k.t : null,
        game_locked: !!k && (k.status === 'in_game' || k.status === 'complete' || Date.parse(k.t) < Date.now()),
        ir_eligible: irEligible(pid),
    };
    if (where === 'starter') p.slot_index = slotIndex;
    return p;
}
function insightsSnapshot(my) {
    const slots = starterSlots();
    const players = [];
    (my.starters || []).forEach((pid, i) => { if (pid && pid !== '0') { const p = insPlayer(pid, 'starter', i); if (p) players.push(p); } });
    const startersSet = new Set((my.starters || []).filter(p => p && p !== '0'));
    const reserve = my.reserve || [], taxi = my.taxi || [];
    for (const pid of my.players || []) { if (startersSet.has(pid) || reserve.includes(pid) || taxi.includes(pid)) continue; const p = insPlayer(pid, 'bench'); if (p) players.push(p); }
    for (const pid of reserve) { const p = insPlayer(pid, 'ir'); if (p) players.push(p); }
    // best FA per position, only for the positions sitting empty
    const best = {}; const rostered = rosteredSet(); const wk = S.proj[S.week] || {};
    slots.forEach((sl, i) => {
        const pid = (my.starters || [])[i]; if (pid && pid !== '0') return;
        const pos = FLEX[sl] ? null : sl; if (!pos || best[pos] || !INS_POS[pos]) return;
        let top = null, tv = -1;
        for (const fp in wk) { if (rostered.has(fp) || ppos(fp) !== pos || isBye(fp, S.week)) continue; const v = wk[fp].pts || 0; if (v > tv) { tv = v; top = fp; } }
        if (top) best[pos] = { ref: String(top), name: pname(top), proj: tv };
    });
    const snap = { version: 1, week: S.week, slots, ir_slots: (S.league.settings || {}).reserve_slots || 0, players };
    if (Object.keys(best).length) snap.best_available = best;
    return snap;
}
// The rules. A row that trips several keeps the one that matters most.
function insCompute(snap) {
    const flexMap = Object.assign({ FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], SF: ['QB', 'RB', 'WR', 'TE'] }, snap.flex_eligibility || {});
    const elig = (pos, slot) => slot === pos || (flexMap[slot] || []).includes(pos);
    const wont = (p) => !!p.on_bye || (INS_NO_PLAY.test((p.status || '').toLowerCase()) && !playedWeek(p.ref, S.week));   // hurt in the game is not "won't play"
    const pj = (p) => (wont(p) ? 0 : p.proj || 0);
    const MIN_DELTA = 1;
    const last = (n) => { const w = String(n).trim().split(/\s+/).filter(x => !/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(x)); return w.length > 1 ? w[w.length - 1] : n; };
    const starters = snap.slots.map(() => null);
    for (const p of snap.players) if (p.where === 'starter' && p.slot_index != null && p.slot_index >= 0 && p.slot_index < snap.slots.length) starters[p.slot_index] = p;
    const bench = snap.players.filter(p => p.where === 'bench');
    const irOpen = (snap.ir_slots || 0) - snap.players.filter(p => p.where === 'ir').length > 0;
    const PRI = { empty_slot: 0, wont_play: 1, out_projected: 2, early_q_late_cover: 3, ir_candidate: 4, bench_beats: 5, bye_next_week: 6 };
    const rows = new Map();
    const put = (ins) => { const l = rows.get(ins.ref) || []; l.push(ins); rows.set(ins.ref, l); };
    snap.slots.forEach((slot, i) => {
        const s = starters[i];
        if (!s) {
            const fa = snap.best_available && snap.best_available[slot];
            const word = slot === 'K' ? 'kicker' : slot === 'DEF' ? 'defense' : slot;
            put({ ref: `slot:${i}`, type: 'empty_slot', severity: 'red', text: fa ? `no ${word} — best FA: ${fa.name} ${fmt1(fa.proj)}` : `no ${word} — empty slot`, action: { kind: 'add_position', position: slot } });
            return;
        }
        if (wont(s)) put({ ref: s.ref, type: 'wont_play', severity: 'red', text: s.on_bye ? 'BYE — projects 0.0' : `${(s.status || 'OUT').toUpperCase()} — projects 0.0`, action: { kind: 'swap' } });
        if (s.bye_next_week) put({ ref: s.ref, type: 'bye_next_week', severity: 'info', text: 'bye next week' });
    });
    // bench out-projects a starter — greedy on descending delta, both sides of one swap
    const pairs = [];
    for (const b of bench) {
        if (wont(b) || b.game_locked) continue;
        snap.slots.forEach((slot, si) => { const s = starters[si]; if (!s || s.game_locked || !elig(b.pos, slot)) return; const d = pj(b) - pj(s); if (d >= MIN_DELTA) pairs.push({ b, si, d }); });
    }
    pairs.sort((a, z) => z.d - a.d);
    const ub = new Set(), us = new Set();
    for (const { b, si, d } of pairs) {
        if (ub.has(b.ref) || us.has(si)) continue;
        ub.add(b.ref); us.add(si);
        const s = starters[si];
        put({ ref: s.ref, type: 'out_projected', severity: 'amber', text: `${last(b.name)} projects +${fmt1(d)}`, action: { kind: 'swap', target_ref: b.ref }, delta: d });
        put({ ref: b.ref, type: 'bench_beats', severity: 'green', text: `beats ${last(s.name)} by ${fmt1(d)}`, action: { kind: 'start', target_ref: s.ref }, delta: d });
    }
    // Questionable starter in an early window with a later-playing eligible cover
    snap.slots.forEach((slot, si) => {
        const s = starters[si];
        if (!s || s.game_locked || !INS_MAYBE.test((s.status || '').toLowerCase()) || !s.kickoff) return;
        const sk = Date.parse(s.kickoff); if (!isFinite(sk)) return;
        let cover = null, ck = 0;
        for (const b of bench) { if (wont(b) || b.game_locked || !elig(b.pos, slot) || !b.kickoff) continue; const bt = Date.parse(b.kickoff); if (isFinite(bt) && bt > sk && bt > ck) { cover = b; ck = bt; } }
        if (cover) put({ ref: s.ref, type: 'early_q_late_cover', severity: 'amber', text: `${s.status === 'Questionable' ? 'Q' : s.status === 'Doubtful' ? 'D' : s.status} in the early game — ${last(cover.name)} (${DAY[new Date(ck).getDay()]}) is the late cover`, action: { kind: 'plan_cover', target_ref: cover.ref } });
    });
    if (irOpen) for (const p of snap.players) if (p.where !== 'ir' && p.ir_eligible) put({ ref: p.ref, type: 'ir_candidate', severity: 'amber', text: 'IR-eligible — an IR slot is open', action: { kind: 'move_ir' } });
    const out = [];
    rows.forEach((l) => { l.sort((a, z) => PRI[a.type] - PRI[z.type]); out.push(l[0]); });
    return out;
}
function insightsIndex(my) {
    const snap = insightsSnapshot(my);
    const key = JSON.stringify(snap);
    // a player who has already played this week is not one who "won't play"
    const list = (insCompute(snap)).filter((i) => !(i.type === 'wont_play' && playedWeek(i.ref, S.week)));
    const by = {}; for (const i of list) by[i.ref] = i;
    return by;
}
function insightCell(INS, ref) {
    const ins = INS[String(ref)];
    if (!ins) return h('td', { class: 'inscol' });
    const cls = ins.severity === 'green' ? 'up' : ins.severity === 'amber' ? 'dn' : ins.severity === 'red' ? 'bad' : 'info';
    const mark = ins.severity === 'green' ? '▲ ' : ins.type === 'out_projected' ? '▼ ' : '';
    return h('td', { class: 'inscol' }, h('span', { class: `ins ${cls}`, title: ins.text }, h('span', { class: 'itxt' }, mark + ins.text)));
}

// ── lineup analysis ──────────────────────────────────────────────────────────
function lineupIssues(roster) {
    const out = []; const slots = starterSlots();
    slots.forEach((s, i) => {
        const pid = (roster.starters || [])[i];
        if (!pid || pid === '0') out.push({ slot: s, i, kind: 'empty', text: `${FLEX[s] ? 'FLEX' : s} is empty` });
        else if (isBye(pid, S.week)) out.push({ slot: s, i, pid, kind: 'bye', text: `${pname(pid)} is on bye` });
        else if (/out|ir|pup|sus/i.test(statusOf(pid) || '') && !playedWeek(pid, S.week)) out.push({ slot: s, i, pid, kind: 'out', text: `${pname(pid)} is ${statusOf(pid)}` });   // hurt in the game is not an issue to fix
    });
    return out;
}
function byeCalendar(roster) {
    const out = [];
    for (let w = S.week; w < S.week + 4 && w <= 18; w++) {
        const who = starterSlots().map((s, i) => (roster.starters || [])[i]).filter(pid => pid && pid !== '0' && isBye(pid, w)).map(pid => (P(pid) || {}).last_name || pname(pid));
        out.push({ w, who });
    }
    return out;
}
// waiver_day_of_week is not a day index: Sleeper offers Tuesday, Wednesday or
// Thursday as 1, 2, 3, and 0 means the league has no weekly run at all.
const WAIVER_DAY = { 1: 2, 2: 3, 3: 4 };   // setting -> JS day (Sun = 0)
function waiverInfo() {
    const st = S.league.settings || {};
    const type = st.waiver_type; // 0 rolling, 1 reverse standings, 2 FAAB
    const d = WAIVER_DAY[st.waiver_day_of_week];
    return { faab: type === 2, day: d != null ? DAY[d] : null, dayIdx: d ?? null, budget: st.waiver_budget || 0, hour: st.daily_waivers_hour };
}
// ── the weekly waiver window ────────────────────────────────────────────────
// Sleeper's rule, read out of its own client: with a weekly waiver day, a
// player whose team has kicked off THIS week can only be claimed, not added,
// until waivers process (3:05am Eastern on the waiver day). Once every game of
// the week has started, that covers everyone, including players nobody has
// rostered. A league with no waiver day never locks anybody this way.
const etOffset = (d) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName').value === 'EDT' ? '-04:00' : '-05:00'; } catch (e) { return '-05:00'; } };
// The week's kickoffs, as timestamps: the live map when it is this week's, else the schedule.
function weekKicks(week) {
    if (S.kickWeek === week && S.kick) { const t = Object.values(S.kick).map(k => k && Date.parse(k.t)).filter(Boolean); if (t.length) return t; }
    const g = (S.schedule || {})[week] || {};
    return [...new Set(Object.values(g).map(x => x && x.date).filter(Boolean))].map(d => Date.parse(`${d}T13:00:00-04:00`));
}
// When this week's claims are processed.
function waiverRunAt(week) {
    const wi = waiverInfo();
    if (allOnWaivers()) { const h = (S.league.settings || {}).daily_waivers_hour || 0; const d = new Date(); d.setHours(h, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); }
    if (wi.dayIdx == null) return null;
    const kicks = weekKicks(week); if (!kicks.length) return null;
    const first = new Date(Math.min(...kicks));
    const d = new Date(first); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + 1);
    while (d.getDay() !== wi.dayIdx) d.setDate(d.getDate() + 1);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return Date.parse(`${ymd}T03:05:00${etOffset(d)}`);
}
// Has this player's team kicked off this week? The kickoff map when it is this
// week's, the schedule otherwise. null means he has no game to wait on — he is
// unsigned, or his team is on bye — and Sleeper holds those two until the whole
// slate has started, so the caller falls through to allKickedOff.
function teamKickedOff(pid, week) {
    const pl = P(pid) || {}; const team = pl.team || (/^[A-Z]{2,3}$/.test(pid) ? pid : null);
    if (!team) return null;   // unsigned: he belongs to no game
    if (S.kickWeek === week && S.kick) { const k = S.kick[team]; if (k) return !!(k.started || k.live || k.over || /complete|in_game|in_progress/i.test(k.status || '')) || (Date.parse(k.t) || Infinity) <= Date.now(); }
    const g = ((S.schedule || {})[week] || {})[team];
    if (!g) return null;      // on bye
    // The schedule carries a status but only a DATE, no kickoff time. Trust the
    // status: dating a kickoff at noon would call a Sunday-night game started
    // seven hours early and show a claim where an add still works.
    if (g.status) return /complete|in_game|in_progress/i.test(g.status);
    return (Date.parse(`${g.date}T13:00:00-04:00`) || Infinity) <= Date.now();
}
// Everyone unrostered is claim-only once every game of the week has started.
// Same rule as teamKickedOff about the schedule: its status is the truth, its
// noon stand-in for a kickoff time is not.
function allKickedOff(week) {
    if (S.kickWeek === week && S.kick) { const t = Object.values(S.kick).map(k => k && Date.parse(k.t)).filter(Boolean); if (t.length) return t.every(x => x <= Date.now()); }
    const v = Object.values((S.schedule || {})[week] || {}).filter(Boolean);
    if (!v.length) return false;
    if (v.some(x => x.status)) return v.every(x => x.status && !/pre/i.test(x.status));
    return v.every(x => (Date.parse(`${x.date}T13:00:00-04:00`) || Infinity) <= Date.now());
}

// ── the playoff picture ──────────────────────────────────────────────────────
// The season simulated to its end and seeded by Sleeper's playoff rules as the
// league has them set. Each unplayed week is scored as N(best-lineup projection,
// WP_K·√points-unplayed) — the same spread the matchup header trusts — and every
// finished season is then seeded.
// What the card shows: the share of simulated seasons in which each thing happened.
function poView() {
    const po = S.po;
    if (!po || !po.res || !po.res.mine) return null;
    const { mine, n, book, playoffTeams } = po.res;
    const p = (x) => n ? Math.round(100 * x / n) : 0;
    const myGame = po.res.myGame;
    return {
        src: 'local', age: 0,
        book, rules: book.seeds.map(r => r.take === 'division_winners' ? 'Division champ' : r.take === 'most_pf' ? 'Points seat' : 'Wild card'),
        counts: book.seeds.map(r => r.take === 'division_winners' ? ((S.league.settings || {}).divisions || 0) : (r.count || 0)),
        byes: (book.seeds[0] && book.seeds[0].byes) || 0, playoffTeams,
        inP: p(mine.in_), byeP: p(mine.bye), magic: mine.magic,
        seed: (i) => p(mine.seed[i] || 0), out: p(mine.out || 0),
        route: (i) => p(mine.route[i] || 0),
        lev: (myGame && mine.winN + mine.loseN > n * 0.2)
            ? { win: n ? Math.round(100 * mine.winIn / mine.winN) : 0, lose: n ? Math.round(100 * mine.loseIn / mine.loseN) : 0 } : null,
    };
}
// Sleeper's own seeding, as rules the simulation can apply (fb-calc.js).
// FBCalc.synthesizeSleeperDefault wants the league's facts rather than
// Sleeper's raw settings, so translate.
function poDefaultRules() {
    const st = S.league.settings || {};
    const nDiv = st.divisions || 0;
    return FBCalc.synthesizeSleeperDefault({
        teams: (S.rosters || []).length || null,
        playoffTeams: st.playoff_teams || 6,
        playoffWeekStart: st.playoff_week_start || null,
        roundType: st.playoff_round_type ?? null,
        divisions: Array.from({ length: nDiv }, (_, i) => ({ id: String(i + 1), name: `Division ${i + 1}` })),
    });
}
// The regular season as matchup pairs per week, from data already loaded.
function poGames() {
    const end = regSeasonEnd(), out = {};
    for (let w = 1; w <= end; w++) {
        const rows = S.matchups[w]; if (!rows || !rows.length) return null;
        const by = {}; for (const m of rows) if (m.matchup_id != null) (by[m.matchup_id] = by[m.matchup_id] || []).push(m);
        out[w] = Object.values(by).filter(p => p.length === 2).map(([x, y]) => ({ a: x.roster_id, b: y.roster_id, pa: x.points || 0, pb: y.points || 0 }));
    }
    return out;
}
async function poEnsureData() {
    loadSeasonMatchups();
    const cur = Math.max(1, S.curWeek), end = regSeasonEnd();
    const jobs = []; for (let w = cur; w <= end; w++) { if (!S.matchups[w]) jobs.push(loadMatchups(w)); jobs.push(loadProj(w).catch(() => {})); }
    await Promise.all(jobs);
    // Every remaining week needs a projection set, or its mean is silently zero
    // and the odds are quietly nonsense — a fortnight of 0–0 games decided by
    // which roster happens to sit on the right-hand side. Fourteen parallel
    // fetches do sometimes come back short; say so and try again rather than
    // publishing a number nobody could reproduce.
    // Judge the weeks by what came back, not by whether the key is set — an
    // empty map is truthy and would sail through.
    // The player map decides which slots a roster can even fill. Without it
    // ppos() knows nobody, nothing is eligible, and the only slot that fills is
    // the defense — whose id is its own team code. A league priced at six
    // points a week is that: one D/ST and eight empty chairs.
    if (!S.players || Object.keys(S.players).length < 500) { console.info(TAG, 'odds: player map not loaded yet — not pricing a season on it'); return null; }
    // Judge a week by what actually SCORED, not by whether the key is set — an
    // empty map is truthy, and a map of unscored rows looks full.
    const thin = [];
    for (let w = cur; w <= end; w++) { const pw = S.proj[w] || {}; if (Object.keys(pw).filter(k => pw[k].pts != null).length < 50) thin.push(w); }
    if (thin.length) { console.info(TAG, 'odds: weeks', thin.join(','), 'carry no scored projections — not pricing a season on them'); return null; }
    return poGames();
}
function poRun() {
    if (S.po && (S.po.running || S.po.key === poKey())) return;
    // the last answer stays on screen while the next is worked out: on a live Sunday the
    // key turns with every point, and blanking the odds each time read as a page that never finishes
    S.po = { running: true, key: poKey(), res: (S.po && S.po.res) || null };
    poEnsureData().then(games => {
        if (!games) {
            // Not an error the user can act on — the week's data is still
            // arriving. HOLD the memo (its key still matches, so the next
            // render leaves it alone) and try afresh in a second, from a
            // timer. Clearing it here and rendering at once was a microtask
            // loop whenever every fetch was already cached — render → poRun →
            // resolve → render — that never yielded to the event loop, and
            // the page froze solid until the tab was closed.
            S.po = { key: poKey(), waiting: true, res: (S.po && S.po.res) || null };
            if (!S.poRetry) { S.poRetry = setTimeout(() => { S.poRetry = null; S.po = null; render(); }, 1000); }
            return;
        }
        poSim(games);
    }).catch(e => { S.po = { key: S.po && S.po.key, error: e.message, res: (S.po && S.po.res) || null }; render(); });
}
const poKey = () => {
    let pts = 0; const wk = S.matchups[S.curWeek]; if (wk) for (const m of wk) pts += m.points || 0;
    return `${S.curWeek}|${Math.round(pts)}|${S.week === S.curWeek && S.kickWeek === S.curWeek ? 'live' : 'floor'}`;
};
// The season played to its end, 3,000 times, by FBCalc.simulateSeason. This
// function only sets the table: the schedule, which weeks are fact, and one
// projected total per roster per unplayed week (the best legal lineup by
// Sleeper's weekly projections).
function poSim(games) {
    const book = poDefaultRules();
    const end = regSeasonEnd(), cur = Math.max(1, S.curWeek);
    const st = S.league.settings || {}, playoffTeams = Math.min(st.playoff_teams || 6, S.rosters.length);
    const rosterIds = S.rosters.map(r => r.roster_id);
    const division = new Map(S.rosters.map(r => [r.roster_id, (r.settings || {}).division || 0]));
    // A week is fact once it is behind us; the one in progress is simulated and
    // floored at the points already on the board, inside the sim.
    const finalWeeks = []; for (let w = 1; w < cur; w++) finalWeeks.push(w);
    const gameMap = new Map();
    for (let w = 1; w <= end; w++) gameMap.set(w, (games[w] || []).map(g => ({ week: w, a: g.a, b: g.b, pa: g.pa, pb: g.pb })));
    const means = new Map();
    for (const R of S.rosters) {
        const m = new Map();
        for (let w = cur; w <= end; w++) m.set(w, bestLineup(R, w).reduce((t, pid) => t + (pid !== '0' ? (projOf(pid, w) || 0) : 0), 0));
        means.set(R.roster_id, m);
    }
    const currentPoints = new Map();
    for (const m of S.matchups[cur] || []) currentPoints.set(m.roster_id, m.points || 0);
    // What each roster still has to come this week: its projected final less the
    // points on the board. With it the sim scores the week in progress as the
    // board plus a draw for only the football left, so a team with everyone
    // played is its score and the odds move as the games are played. Read only
    // when this week's kickoffs are in hand; otherwise the sim keeps its floor.
    let currentRemaining;
    if (S.week === cur && S.kickWeek === cur) {
        currentRemaining = new Map();
        for (const m of S.matchups[cur] || []) { const R = rosterById(m.roster_id); if (R) currentRemaining.set(m.roster_id, Math.max(0, muProjected(R, m) - (m.points || 0))); }
    }
    let mtot = 0, mcnt = 0; for (const m of means.values()) for (const v of m.values()) { mtot += v; mcnt++; }
    console.info(TAG, `odds inputs: wk ${cur}-${end}, ${rosterIds.length} rosters, mean/team/wk ${(mtot / Math.max(1, mcnt)).toFixed(1)}, book "${book.label}"`);
    const t0 = performance.now();
    const res = FBCalc.simulateSeason({
        rosterIds, division, games: gameMap, finalWeeks, currentWeek: cur,
        regularSeasonWeeks: end, means, currentPoints, currentRemaining, book, playoffTeams,
    });
    const myRid = S.myRoster && S.myRoster.roster_id;
    const mine = res.teams.get(myRid) || null;
    const took = Math.round(performance.now() - t0);
    if (took > 400) console.info(TAG, `season sim: ${res.n} seasons in ${took}ms`);
    S.po = { key: S.po.key, res: {
        book, playoffTeams, remaining: res.remaining, n: res.n, teams: res.teams, mine,
        myGame: (games[cur] || []).find(g => g.a === myRid || g.b === myRid) || null,
        source: 'local',
    } };
    render();
}
// The playoff picture. Its number is a line at the top of the standings; the
// rest opens beneath it by hand, and only from the halfway mark — an early
// 46% doesn't deserve a panel, and the standings are the thing you came for.
const poHalfway = () => Math.ceil(regSeasonEnd() / 2);
function poOpen() { if (S.ui.poOpen != null) return S.ui.poOpen; let v = false; try { v = localStorage.getItem('badgerPoOpen') === '1'; } catch (e) {} return (S.ui.poOpen = v); }
function setPoOpen(v) { S.ui.poOpen = v; try { localStorage.setItem('badgerPoOpen', v ? '1' : '0'); } catch (e) {} render(); }
function poLine() {
    if (S.seasonType !== 'regular' || S.curWeek > regSeasonEnd() || !S.myRoster) return [];
    poRun();
    const V = poView(), po = S.po;
    const unlocked = S.curWeek >= poHalfway();
    const open = unlocked && poOpen();
    const line = h('div', { class: `poline${open ? ' open' : ''}` });
    if (!V) {
        line.append(po && po.error ? h('span', { class: 'dim' }, `Couldn't simulate: ${po.error}`) : h('span', { class: 'dim' }, h('span', { class: 'spin' }), ' Playing out the season 3,000 times\u2026'));
        return [line];
    }
    // What kind of number it is belongs on the line, not in a warning.
    const src = 'simulated';
    line.append(h('b', { class: 'big mono' }, `${V.inP}%`),
        h('span', { class: 'txt' }, h('b', null, `make the ${V.playoffTeams}`),
            V.byes ? ` \u00b7 bye ${V.byeP}%` : '',
            V.magic != null ? ` \u00b7 magic number ${V.magic}` : (S.curWeek <= 2 ? ' \u00b7 too early to mean much' : '')),
        h('span', { class: 'src mono dim' }, src));
    if (unlocked) line.append(h('span', { class: 'poexp', onclick: () => setPoOpen(!open) }, open ? 'fold ' : 'full picture ', caret('', open)));
    else line.append(h('span', { class: 'poexp off', title: `Opens at the halfway mark \u2014 week ${poHalfway()}` }, `full picture \u00b7 wk ${poHalfway()}`));
    if (!open) return [line];
    const label = (V.book && V.book.label) || 'Sleeper default rules';
    return [line, h('div', { class: 'popanel' },
        h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:6px' }, `${label} \u00b7 ${regSeasonEnd() - Math.max(1, S.curWeek) + 1} weeks left`),
        poBody(V, po))];
}
function poBody(V, po) {
    const playoffTeams = V.playoffTeams;
    const pIn = V.inP, pBye = V.byeP, magic = V.magic;
    // Routes in: one line per seeding rule that ever seated you.
    const routes = V.rules.map((name, i) => ({
        name: name === 'Division champ' ? 'win the division' : name === 'Points seat' ? 'points wild card' : 'record wild card',
        p: V.route(i), pts: name === 'Points seat',
    })).filter(r => r.p > 0);
    const routeRow = (r) => h('div', { class: 'porow' }, h('span', { class: 'dim' }, r.name),
        h('div', { class: 'pobar' }, h('i', { style: `width:${r.p}%;` + (r.pts ? 'background:var(--amber)' : '') })), h('span', { class: 'mono' }, `${r.p}%`));
    // Seed histogram, byed seeds marked, the points seat amber.
    const ptsRules = new Set(V.rules.map((nm, i) => nm === 'Points seat' ? i : -1).filter(i => i >= 0));
    const byes = V.byes;
    const seedCells = []; let maxSeedP = 1;
    for (let i = 1; i <= playoffTeams; i++) maxSeedP = Math.max(maxSeedP, V.seed(i)); maxSeedP = Math.max(maxSeedP, V.out);
    // Which rule fills seat i — walking the seats each rule takes.
    const counts = V.counts;
    const seatRule = (i) => { if (!counts || !counts.length) return Math.min(i - 1, V.rules.length - 1); let k = 0;
        for (let ri = 0; ri < counts.length; ri++) { k += counts[ri]; if (i <= k) return ri; } return counts.length - 1; };
    for (let i = 1; i <= playoffTeams; i++) {
        seedCells.push({ lab: h('span', null, String(i), ptsRules.has(seatRule(i)) ? '\u00b7pts' : null, i <= byes ? h('small', { class: 'pobye' }, 'bye') : null), v: V.seed(i), cls: ptsRules.has(seatRule(i)) ? 'amb' : 'in' });
    }
    seedCells.push({ lab: 'out', v: V.out, cls: 'out' });
    const hist = h('div', { class: 'pohist' }, ...seedCells.map(c => h('div', { class: 'pocol', title: `${c.v}%` },
        h('div', { class: `pocolbar ${c.cls}`, style: `height:${Math.round(56 * c.v / maxSeedP) + 2}px` }), h('div', { class: 'pocollab mono dim' }, c.lab))));
    // This week's leverage.
    let lev = null;
    if (V.lev) {
        const mg = (po && po.res && po.res.myGame) || null;
        const opp = mg ? rosterById(mg.a === S.myRoster.roster_id ? mg.b : mg.a) : null;
        const mm = myMatchup(S.curWeek);
        const oppName = opp ? teamName(opp) : (mm && mm.opp ? teamName(rosterById(mm.opp.roster_id)) : '?');
        lev = h('div', { style: 'margin-top:8px' },
            h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:3px' }, `WEEK ${S.curWeek} vs ${oppName}`),
            h('div', { class: 'porow' }, h('span', { class: 'chip green' }, 'WIN'), h('div', { class: 'pobar' }, h('i', { style: `width:${V.lev.win}%` })), h('span', { class: 'mono' }, `${V.lev.win}%`)),
            h('div', { class: 'porow' }, h('span', { class: 'chip red' }, 'LOSE'), h('div', { class: 'pobar' }, h('i', { style: `width:${V.lev.lose}%;background:var(--red)` })), h('span', { class: 'mono' }, `${V.lev.lose}%`)));
    }
    // The points race, when the rules have a points seat: live PF, not sim.
    let race = null;
    if (ptsRules.size) {
        const pfRank = S.rosters.map(R => ({ R, pf: pf(R) })).sort((a, b) => b.pf - a.pf);
        const myIx = pfRank.findIndex(x => x.R.roster_id === S.myRoster.roster_id);
        const around = pfRank.slice(Math.max(0, myIx - 2), myIx + 2);
        race = h('div', { style: 'margin-top:8px' },
            h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:3px' }, 'THE POINTS RACE · season PF'),
            h('div', { style: 'display:grid;grid-template-columns:1fr auto auto;gap:2px 10px;font-size:12px' },
                ...around.flatMap(x => { const mine = x.R.roster_id === S.myRoster.roster_id;
                    return [h('span', { class: mine ? 'teal' : '', style: mine ? 'font-weight:700' : '' }, mine ? 'You' : teamName(x.R)),
                        h('span', { class: 'mono' + (mine ? ' teal' : '') }, fmt1(x.pf)),
                        h('span', { class: 'mono dim', style: 'font-size:11px' }, mine ? '' : `${x.pf >= pfRank[myIx].pf ? '+' : ''}${fmt1(x.pf - pfRank[myIx].pf)}`)]; })),
            h('div', { class: 'dim', style: 'font-size:11px;margin-top:3px' }, 'A losing record still cashes this seat — the race only ends when the points say so.'));
    }
    return h('div', { class: 'pogrid' },
        h('div', null,
            h('div', { style: 'display:flex;align-items:baseline;gap:8px' }, h('b', { class: 'mono teal', style: 'font-size:30px;letter-spacing:-.02em' }, `${pIn}%`), h('span', { class: 'dim', style: 'font-size:12px' }, `make the ${playoffTeams}`)),
            byes ? h('div', { class: 'dim', style: 'font-size:11.5px' }, `First-round bye ${pBye}%`, magic != null ? ` · magic number ${magic}` : '') : (magic != null ? h('div', { class: 'dim', style: 'font-size:11.5px' }, `Magic number ${magic}`) : null),
            h('div', { class: 'muted', style: 'font-size:11px;margin:8px 0 3px' }, 'HOW YOU GET IN'),
            ...(routes.length ? routes.map(routeRow) : [h('div', { class: 'dim', style: 'font-size:11.5px' }, 'No path found in 3,000 seasons — the points race below is the honest hope.')]),
            lev),
        h('div', null, h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:3px' }, 'WHERE YOU LAND'), hist, race));
}

// ── the season vault ─────────────────────────────────────────────────────────
// Past seasons of this league, read whole from Sleeper's archive via the
// previous_league_id chain: champion and bracket, standings, the ledger
// pointed backwards, the draft as picked — and any matchup reopened with its
// win-probability curve rebuilt from every snap (the same machinery the live
// matchup page runs, which reproduces a finished championship to the cent).
//
// The trick that keeps this small: every renderer in this file reads the S
// globals, so the vault fetches a dead season into its own bag and renders
// EXISTING components inside withVault(), a synchronous swap of those globals.
// Two hard rules keep it safe: nothing async ever runs under the swap (an
// awaited write would land in live state after restore), and S.fracDone tells
// the live-game helpers that every game here is history.
const VAULTS = {};
async function loadSeasonChain() {
    if (S.chain) return; S.chain = [];
    try {
        let id = S.league && S.league.previous_league_id;
        while (id && id !== '0' && S.chain.length < 10) {
            let meta = await idbGet(`vaultmeta:${id}`);
            if (!meta) {
                const lg = await rest(`${API}/league/${id}`);
                let champ = null;
                try {
                    const wb = await rest(`${API}/league/${id}/winners_bracket`);
                    const fin = (wb || []).find(m2 => m2.p === 1);
                    if (fin && fin.w != null) {
                        const [rs, us] = await Promise.all([rest(`${API}/league/${id}/rosters`), rest(`${API}/league/${id}/users`)]);
                        const R = rs.find(r => r.roster_id === fin.w); const u = R && us.find(u2 => String(u2.user_id) === String(R.owner_id));
                        champ = u ? ((u.metadata || {}).team_name || u.display_name) : null;
                    }
                } catch (e) { /* a season with no bracket still lists */ }
                meta = { id, season: lg.season, name: lg.name, prev: lg.previous_league_id, champ };
                await idbSet(`vaultmeta:${id}`, meta);
            }
            S.chain.push(meta); id = meta.prev;
        }
    } catch (e) { console.warn(TAG, 'chain:', e.message); }
    if (S.chain.length) { console.log(TAG, `season chain: ${S.chain.map(c => c.season).join(', ')}`); render(); }
}
function withVault(V, fn) {
    const K = ['league', 'leagueId', 'rosters', 'users', 'season', 'seasonType', 'matchups', 'txns', 'proj', 'stats', 'plays', 'wpHist', 'ledger', 'myRoster', 'week', 'curWeek', 'kick', 'kickWeek', 'kickByWeek', 'fracDone', 'seasonLedger', 'seasonLedgerBusy', 'leagueDraftPicks'];
    const saved = {}; for (const k of K) saved[k] = S[k];
    S.league = V.league; S.leagueId = V.id; S.rosters = V.rosters; S.users = V.users; S.season = V.season; S.seasonType = 'regular';
    S.matchups = V.matchups; S.txns = V.txns; S.proj = V.proj; S.stats = V.stats; S.plays = V.plays;
    S.wpHist = V.wpHist; S.ledger = V.playLedger; S.myRoster = V.myRoster; S.leagueDraftPicks = V.picks;
    S.week = V.ui.week || 1; S.curWeek = 19; S.kick = {}; S.kickWeek = null; S.kickByWeek = {}; S.fracDone = true;   // a past season's weeks never read this season's games
    S.seasonLedger = V.seasonLedger; S.seasonLedgerBusy = true;   // busy=true: never let the tab kick a live fetch
    try { return fn(); } finally { for (const k of K) S[k] = saved[k]; }
}
function vaultOpen(id) {
    S.ui.menu = false;
    S.ui.vault = { id };
    vaultLoad(id);
    render(); app.scrollTop = 0; window.scrollTo(0, 0);
}
async function vaultLoad(id) {
    let V = VAULTS[id]; if (V && V.status !== 'error') return;
    V = VAULTS[id] = { status: 'loading', id, matchups: {}, txns: {}, proj: {}, stats: {}, plays: {}, wpHist: {}, playLedger: {}, wkReady: {}, ui: { tab: 'standings', week: null, matchupRoster: null } };
    try {
        let b = await idbGet(`vault:${id}`);
        if (!b) {
            const [league, rosters, users, picks, bracket] = await Promise.all([
                rest(`${API}/league/${id}`), rest(`${API}/league/${id}/rosters`), rest(`${API}/league/${id}/users`),
                (async () => { try { const ds = await rest(`${API}/league/${id}/drafts`); const d = ds && ds[0]; return d ? await rest(`${API}/draft/${d.draft_id}/picks`) : []; } catch (e) { return []; } })(),
                rest(`${API}/league/${id}/winners_bracket`).catch(() => []),
            ]);
            const [weeks, txns] = await Promise.all([
                Promise.all(Array.from({ length: 18 }, (_, i) => rest(`${API}/league/${id}/matchups/${i + 1}`).catch(() => []))),
                Promise.all(Array.from({ length: 18 }, (_, i) => rest(`${API}/league/${id}/transactions/${i + 1}`).catch(() => []))),
            ]);
            b = { league, rosters, users, picks, bracket, weeks, txns };
            await idbSet(`vault:${id}`, b);   // a dead season never changes
        }
        V.league = b.league; V.rosters = b.rosters; V.users = b.users; V.picks = b.picks; V.bracket = b.bracket || [];
        V.season = b.league.season;
        for (let w = 1; w <= 18; w++) {
            if (b.weeks[w - 1] && b.weeks[w - 1].length) V.matchups[w] = b.weeks[w - 1];
            if (b.txns[w - 1] && b.txns[w - 1].length) V.txns[w] = b.txns[w - 1];
        }
        V.myRoster = V.rosters.find(r => String(r.owner_id) === String(S.myUserId) || (r.co_owners || []).map(String).includes(String(S.myUserId))) || null;
        V.status = 'ready';
        V.seasonLedger = withVault(V, () => ledgerCompute());
        V.seeds = vaultSeeds(V);
        V.finish = vaultPlacements(V.bracket);
    } catch (e) { V.status = 'error'; V.error = e.message; }
    render();
}
// Seed labels for the bracket, from the same interpreter the playoff picture
// trusts: Sleeper's rules, read from that season's archived settings.
// Labels only appear when the computed round-one pairings match the bracket
// Sleeper actually ran; a mismatched read stays silent rather than wrong.
function vaultSeeds(V) {
    try {
        const res = withVault(V, () => {
            const L = ledgerCompute(); if (!L) return null;
            const div = {}; for (const r of V.rosters) div[r.roster_id] = (r.settings || {}).division || 0;
            const teams = Object.values(L.T).map(t => ({ rid: t.rid, w: t.w, l: t.l, t: t.t, pf: t.pf, division: div[t.rid] }));
            const h2h = (a2, b2) => { let x = 0, y = 0; for (const w of L.weeks) { const rows = V.matchups[w] || []; const ma = rows.find(m2 => m2.roster_id === a2), mb = rows.find(m2 => m2.roster_id === b2); if (!ma || !mb || ma.matchup_id !== mb.matchup_id) continue; if ((ma.points || 0) > (mb.points || 0)) x++; else if ((mb.points || 0) > (ma.points || 0)) y++; } return [x, y]; };
            const book = poDefaultRules();   // S here is swapped: poDefaultRules reads archived settings
            return { book, ...FBCalc.applyRules(book, teams, h2h, Math.min((V.league.settings || {}).playoff_teams || 6, teams.length)) };
        });
        if (!res) return null;
        const seedOf = {}; res.seeds.forEach((x, i) => seedOf[x.rid] = i + 1);
        // Labels only when every round-1 bracket team is one we seeded — a
        // seeding the interpreter can't reproduce stays unlabelled.
        const ok = (V.bracket || []).filter(m2 => m2.r === 1).every(g => seedOf[g.t1] && seedOf[g.t2]);
        return ok ? { seedOf, byes: res.byes, ptsRule: res.seeds.filter(x2 => (res.book.seeds[x2.rule] || {}).take === 'most_pf').map(x2 => x2.rid) } : null;
    } catch (e) {
        // A silent null here once hid a ReferenceError for a whole afternoon —
        // the interpreter had moved into fb-calc and this call hadn't followed.
        // Staying unlabelled is the right behaviour; staying quiet about why is not.
        console.warn(TAG, 'vault seeds:', e.message, '\u2014 bracket unlabelled');
        return null;
    }
}
// Final placements from the bracket's placement games: p:1 = title, p:3, p:5.
function vaultPlacements(bracket) {
    const out = {};
    for (const m2 of bracket || []) {
        if (m2.p == null || m2.w == null || m2.l == null) continue;
        out[m2.w] = m2.p; out[m2.l] = m2.p + 1;
    }
    return out;
}
async function vaultWeek(V, w) {
    const k = String(w);
    if (V.wkReady[k] === 'ready' || V.wkReady[k] === 'loading') return;
    V.wkReady[k] = 'loading'; render();
    try {
        let wk = await idbGet(`vaultwk:${V.id}:${w}`);
        if (!wk) {
            const POSQ = 'position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF';
            const [proj, stats, d] = await Promise.all([
                rest(`${API2}/projections/nfl/${V.season}/${w}?season_type=regular&${POSQ}&order_by=pts_half_ppr`).catch(() => []),
                rest(`${API2}/stats/nfl/${V.season}/${w}?season_type=regular&${POSQ}&order_by=pts_half_ppr`).catch(() => []),
                gql('plays', `query plays { plays(sport: "nfl", season: "${V.season}", season_type: "regular", week: ${w}){ time game_id metadata play_stats { player_id stats } } }`).catch(() => ({ plays: [] })),
            ]);
            wk = { proj, stats, plays: (d.plays || []).slice().sort(byPlayOrder) };
            await idbSet(`vaultwk:${V.id}:${w}`, wk);
        }
        withVault(V, () => {   // scoreStats needs the ARCHIVED league's scoring
            const pm = {}; for (const x of wk.proj) pm[x.player_id] = { pts: scoreStats(x.stats), opp: x.opponent, game: x.game_id, team: x.team, stats: x.stats };
            const sm = {}; for (const x of wk.stats) sm[x.player_id] = { pts: scoreStats(x.stats), opp: x.opponent, stats: x.stats };
            V.proj[w] = pm; V.stats[w] = sm;
        });
        V.plays[w] = { at: Date.now(), done: true, list: wk.plays.slice().sort(byPlayOrder) };   // an archived week cached under the old order sorts on read too
        V.wkReady[k] = 'ready';
    } catch (e) { V.wkReady[k] = 'error'; console.warn(TAG, 'vault week:', e.message); }
    render();
}
function vaultPage() {
    const id = S.ui.vault.id;
    const meta = (S.chain || []).find(c => c.id === id) || {};
    const V = VAULTS[id];
    const page = h('div', { class: (V && V.ui && V.ui.tab === 'matchups') ? 'page matchup' : 'page' });
    const name = (rid) => { const R = rosterById2(V, rid); if (!R) return `Roster ${rid}`;
        const u = ((V && V.users) || []).find(u2 => String(u2.user_id) === String(R.owner_id));
        return (u && (((u.metadata || {}).team_name || '').trim() || u.display_name)) || `Team ${rid}`; };
    // One header line carries the whole identity: back, season, champion, mode.
    const fin = V && (V.bracket || []).find(m2 => m2.p === 1);
    const head = h('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' },
        h('button', { class: 'btn sm s', onclick: () => { S.ui.vault = null; render(); } }, `\u2190 Back to ${S.season}`),
        h('h3', { style: 'margin:0' }, 'Season Vault'),
        h('div', { class: 'tabs' }, ...(S.chain || []).map(c => h('span', { class: c.id === id ? 'on' : '', onclick: () => vaultOpen(c.id) }, c.season))),
        fin ? h('span', { class: 'dim', style: 'font-size:12px' }, '\u{1F3C6} ', h('b', { class: 'vgold' }, name(fin.w)), ` \u00b7 beat ${name(fin.l)} in the final`) : null,
        h('span', { class: 'chip', style: 'margin-left:auto' }, 'read-only \u00b7 from Sleeper\u2019s archive'));
    const card = h('div', { class: 'card span2' }, head);
    page.append(card);
    if (!V || V.status === 'loading') { card.append(h('div', { class: 'cap', style: 'margin-top:8px' }, h('span', { class: 'spin' }), `Reading the ${meta.season || ''} season back from the archive\u2026 (first open fetches the whole year; after that it\u2019s instant)`)); return page; }
    if (V.status === 'error') { card.append(h('div', { class: 'cap', style: 'margin-top:8px' }, `The archive did not answer: ${V.error}`, ' ', h('button', { class: 'btn sm', onclick: () => { VAULTS[id] = null; vaultLoad(id); render(); } }, 'Retry'))); return page; }

    const tab = V.ui.tab;
    card.append(h('div', { style: 'margin-top:10px' },
        h('div', { class: 'tabs' }, ...[['standings', 'Standings'], ['ledger', '\u{1F4D2} Ledger'], ['matchups', 'Matchups'], ['draft', 'Draft']].map(([k, t]) => h('span', { class: k === tab ? 'on' : '', onclick: () => { V.ui.tab = k; render(); } }, t)))));

    if (tab === 'standings') {
        // The unified standings, vault flavour (Finish column, points-seat
        // chip), with the bracket beside it — the Finish column IS the
        // bracket, so they read as one page.
        const table = withVault(V, () => standingsTable(true, { finish: V.finish || {}, pts: new Set((V.seeds && V.seeds.ptsRule) || []) }));
        let bracketEl = null;
        if ((V.bracket || []).length) {
            const bySeed = (rid) => V.seeds && V.seeds.seedOf[rid] ? h('span', { class: 'vsd mono' }, V.seeds.seedOf[rid]) : null;
            // A bracket game names a week: playoff_week_start + round. Click
            // through to the matchup itself, curve and all.
            const wkOf = (r2) => {
                let w2 = ((V.league.settings || {}).playoff_week_start || 15) + (r2 - 1);
                if (!V.matchups[w2]) { const ws = Object.keys(V.matchups).map(Number).sort((x, y) => x - y); w2 = ws[ws.length - 1]; }
                return w2;
            };
            const line = (rid, won) => h('div', { class: `vline ${won ? '' : 'dim'}` },
                bySeed(rid), h('b', { class: 'nm', title: name(rid) }, name(rid)), won ? h('span', { class: 'teal mono', style: 'flex:none' }, 'W') : null);
            const gm = (m2) => h('div', { class: `vbx clk ${m2.p === 1 ? 'w' : ''}`, title: 'Open this matchup', onclick: () => { V.ui.tab = 'matchups'; V.ui.week = wkOf(m2.r); V.ui.matchupRoster = m2.w != null ? m2.w : m2.t1; render(); } },
                line(m2.t1, m2.w === m2.t1), line(m2.t2, m2.w === m2.t2),
                m2.p ? h('div', { class: 'dim mono', style: 'font-size:9.5px;margin-top:3px' }, m2.p === 1 ? '\u{1F3C6} title' : `${ordinal(m2.p)} place game`) : null);
            const shown = V.bracket.filter(m2 => (m2.p == null || m2.p === 1) || V.ui.brAll);
            const hiddenN = V.bracket.length - V.bracket.filter(m2 => m2.p == null || m2.p === 1).length;
            const rounds = [...new Set(shown.map(m2 => m2.r))].sort((a2, b2) => a2 - b2);
            bracketEl = h('div', null,
                h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:6px' }, `THE BRACKET \u00b7 reseeded${V.seeds && V.seeds.byes ? ` \u00b7 seeds 1\u2013${V.seeds.byes} byed` : ''}`),
                h('div', { class: 'vbr', style: `grid-template-columns:repeat(${rounds.length},1fr);min-width:0` },
                    ...rounds.map(r => h('div', { style: 'display:grid;gap:8px;align-content:center' }, ...shown.filter(m2 => m2.r === r).map(gm)))),
                hiddenN > 0 ? h('div', { class: 'lnk', style: 'font-size:11.5px;margin-top:6px;cursor:pointer', onclick: () => { V.ui.brAll = !V.ui.brAll; render(); } }, V.ui.brAll ? 'hide placement games' : `\uFF0B ${hiddenN} placement game${hiddenN === 1 ? '' : 's'}`) : null);
        }
        card.append(h('div', { class: 'vsplit', style: 'margin-top:10px' }, h('div', { class: 'scroll-x' }, table), bracketEl));
    } else if (tab === 'ledger') {
        card.append(h('div', { style: 'margin-top:10px' }, withVault(V, () => ledgerBody())));
    } else if (tab === 'draft') {
        const picks = V.picks || [];
        if (!picks.length) card.append(h('div', { class: 'empty' }, 'No draft on file for this season.'));
        else {
            const rounds = [...new Set(picks.map(p => p.round))].sort((a2, b2) => a2 - b2);
            const tbl = h('table', null);
            for (const r of rounds) {
                tbl.append(h('tr', { class: 'secrow' }, h('td', { colspan: 2 }, h('b', null, `Round ${r}`))));
                for (const p of picks.filter(p2 => p2.round === r).sort((a2, b2) => a2.pick_no - b2.pick_no)) {
                    tbl.append(h('tr', null,
                        h('td', { class: 'mono dim', style: 'width:52px' }, `${r}.${String(p.pick_no - (r - 1) * (V.rosters.length || 12)).padStart(2, '0')}`),
                        h('td', null, h('span', { class: `pos ${ppos(p.player_id)}`, style: 'font-size:9px;min-width:26px;height:16px;margin-right:7px' }, posLabel(ppos(p.player_id))),
                            h('b', { style: 'cursor:pointer', onclick: () => { S.ui.sel = p.player_id; render(); } }, pname(p.player_id)),
                            h('span', { class: 'dim', style: 'font-size:11.5px' }, ` \u2014 ${name(p.roster_id)}`))));
                }
            }
            card.append(h('div', { class: 'scroll-x', style: 'margin-top:10px;max-height:520px;overflow-y:auto' }, tbl));
        }
    } else if (tab === 'matchups') {
        const weeks = Object.keys(V.matchups).map(Number).sort((a2, b2) => a2 - b2);
        // Land on the week the title was decided, not a junk consolation week
        // hanging off the end of the schedule.
        let w = V.ui.week;
        if (!w) {
            const br = V.bracket || [];
            const maxR = br.length ? Math.max(...br.map(m2 => m2.r)) : 0;
            const titleW = maxR ? ((V.league.settings || {}).playoff_week_start || 15) + maxR - 1 : null;
            w = (titleW && V.matchups[titleW]) ? titleW : weeks[weeks.length - 1];
        }
        V.ui.week = w;
        card.append(h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap' },
            h('span', { class: 'muted', style: 'font-size:11px' }, 'WEEK'),
            h('div', { class: 'tabs' }, ...weeks.map(w2 => h('span', { class: w2 === w ? 'on' : '', onclick: () => { V.ui.week = w2; V.ui.matchupRoster = null; render(); } }, String(w2))))));
        const st3 = V.wkReady[String(w)];
        if (st3 !== 'ready') { if (st3 !== 'loading' && st3 !== 'error') vaultWeek(V, w);
            card.append(h('div', { class: 'cap' }, st3 === 'error' ? h('span', null, 'The play archive did not answer for this week. ', h('button', { class: 'btn sm', onclick: () => { V.wkReady[String(w)] = null; vaultWeek(V, w); } }, 'Retry')) : [h('span', { class: 'spin' }), `Pulling week ${w}\u2019s plays, projections and stats from the archive\u2026 (~3MB, cached forever)`]));
            return page; }
        withVault(V, () => {
            const ms = S.matchups[w] || [];
            let R = V.ui.matchupRoster ? rosterById(V.ui.matchupRoster) : (S.myRoster && ms.some(m2 => m2.roster_id === S.myRoster.roster_id) ? S.myRoster : rosterById(ms[0] && ms[0].roster_id));
            const a2 = R ? ms.find(m2 => m2.roster_id === R.roster_id) : null;
            const b2 = a2 ? ms.find(m2 => m2.matchup_id === a2.matchup_id && m2.roster_id !== a2.roster_id) : null;
            const B = b2 ? rosterById(b2.roster_id) : null;
            card.append(h('div', { style: 'margin-top:10px' }, matchupTiles(a2 && a2.matchup_id, (rid) => { V.ui.matchupRoster = rid; render(); })));
            if (a2 && R) page.append(matchupHeader(R, false));
            if (a2 && B) { page.append(muMirror(R, a2, B, b2)); page.append(playLog(R, a2, B, b2)); }
            else if (a2) page.append(h('div', { class: 'card span2' }, h('div', { class: 'empty' }, 'Bye or unpaired week.')));
        });
    }
    return page;
}
const rosterById2 = (V, id2) => V.rosters.find(r => String(r.roster_id) === String(id2)) || null;

// ── the ledger ───────────────────────────────────────────────────────────────
// The season, settled with numbers: luck (record vs all-play), points left on
// the bench (named, not just counted), the adds and drops that mattered, and
// what each draft class actually scored. Computed from data the page already
// fetches week by week; unlocked when the regular season ends (or via the
// console preview badgerLedger() for the impatient).
function ledgerWeeksDone() {
    const end = regSeasonEnd(), out = [];
    for (let w = 1; w <= end && w < S.curWeek; w++) if (S.matchups[w] && S.matchups[w].length) out.push(w);
    return out;
}
async function ensureLedgerData() {
    const jobs = [];
    for (let w = 1; w <= Math.min(regSeasonEnd(), Math.max(1, S.curWeek)); w++) { if (!S.matchups[w]) jobs.push(loadMatchups(w)); if (!S.txns[w]) jobs.push(loadTxns(w)); }
    if (!S.leagueDraftPicks) jobs.push((async () => {
        try { const ds = await rest(`${API}/league/${S.leagueId}/drafts`); const d = ds && ds[0];
            S.leagueDraftPicks = d ? await rest(`${API}/draft/${d.draft_id}/picks`) : []; }
        catch (e) { S.leagueDraftPicks = []; }
    })());
    await Promise.all(jobs);
}
function ledgerCompute() {
    const weeks = ledgerWeeksDone(); if (!weeks.length) return null;
    const T = {}; const DIV = {};
    for (const R of S.rosters) { T[R.roster_id] = { rid: R.roster_id, w: 0, l: 0, t: 0, dw: 0, dl: 0, dt: 0, apW: 0, apL: 0, pf: 0, pa: 0, bench: 0, benchWeeks: [], adds: [], drops: [] }; DIV[R.roster_id] = (R.settings || {}).division || 0; }
    const rows = {}; for (const w of weeks) { rows[w] = {}; for (const m of S.matchups[w]) rows[w][m.roster_id] = m; }
    for (const w of weeks) {
        const list = S.matchups[w].filter(m => m.matchup_id != null && T[m.roster_id]);
        const by = {}; for (const m of list) (by[m.matchup_id] = by[m.matchup_id] || []).push(m);
        for (const pair of Object.values(by)) if (pair.length === 2) {
            const [a, b] = pair;
            const sameDiv = DIV[a.roster_id] && DIV[a.roster_id] === DIV[b.roster_id];
            T[a.roster_id].pa += b.points || 0; T[b.roster_id].pa += a.points || 0;
            if ((a.points || 0) > (b.points || 0)) { T[a.roster_id].w++; T[b.roster_id].l++; if (sameDiv) { T[a.roster_id].dw++; T[b.roster_id].dl++; } }
            else if ((b.points || 0) > (a.points || 0)) { T[b.roster_id].w++; T[a.roster_id].l++; if (sameDiv) { T[b.roster_id].dw++; T[a.roster_id].dl++; } }
            else { T[a.roster_id].t++; T[b.roster_id].t++; if (sameDiv) { T[a.roster_id].dt++; T[b.roster_id].dt++; } }
        }
        for (const m of list) {
            const t2 = T[m.roster_id]; const pts = m.points || 0;
            t2.pf += pts;
            for (const o of list) { if (o === m) continue; const op = o.points || 0; if (pts > op) t2.apW++; else if (pts < op) t2.apL++; else { t2.apW += 0.5; t2.apL += 0.5; } }
            if (m.players_points) {
                const opt = Math.max(optimalPointsFrom(m), pts), lost = opt - pts;
                if (lost > 0.05) {
                    const pp = m.players_points, sSet = new Set((m.starters || []).filter(p => p && p !== '0'));
                    let sat = null, sv = -1; for (const pid of (m.players || [])) if (!sSet.has(pid) && (pp[pid] || 0) > sv) { sv = pp[pid] || 0; sat = pid; }
                    let started = null, iv = Infinity; for (const pid of sSet) if ((pp[pid] || 0) < iv) { iv = pp[pid] || 0; started = pid; }
                    t2.benchWeeks.push({ w, lost, sat, satPts: sv, started, startedPts: iv });
                }
                t2.bench += lost;
            }
        }
    }
    // Adds are graded by the points they STARTED for you afterwards; drops by
    // what the player started for somebody else once you let him go.
    const startedFor = (rid, pid, fromW) => { let sum = 0, g = 0; for (const w of weeks) { if (w < fromW) continue; const m = rows[w][rid]; if (!m || !m.players_points || m.players_points[pid] == null) continue; if ((m.starters || []).includes(pid)) { sum += m.players_points[pid]; g++; } } return { sum, g }; };
    const elsewhere = (rid, pid, fromW) => { let sum = 0; for (const w of weeks) { if (w < fromW) continue; for (const m of S.matchups[w]) { if (m.roster_id === rid || !m.players_points || m.players_points[pid] == null) continue; if ((m.starters || []).includes(pid)) sum += m.players_points[pid]; } } return sum; };
    for (let w = 1; w <= Math.min(regSeasonEnd(), Math.max(1, S.curWeek)); w++) for (const t3 of (S.txns[w] || [])) {
        if (t3.status !== 'complete' || (t3.type !== 'waiver' && t3.type !== 'free_agent')) continue;
        const rid = (t3.roster_ids || [])[0]; if (!rid || !T[rid]) continue;
        const leg = t3.leg || w;
        for (const pid in (t3.adds || {})) { const r2 = startedFor(rid, pid, leg); if (r2.g) T[rid].adds.push({ pid, w: leg, pts: r2.sum, bid: t3.settings && t3.settings.waiver_bid != null ? t3.settings.waiver_bid : null }); }
        for (const pid in (t3.drops || {})) { const sum = elsewhere(rid, pid, leg); if (sum > 0) T[rid].drops.push({ pid, w: leg, pts: sum }); }
    }
    const draftPts = {};
    for (const p of (S.leagueDraftPicks || [])) { const rid = p.roster_id; if (!T[rid] || !p.player_id) continue; draftPts[rid] = (draftPts[rid] || 0) + startedFor(rid, p.player_id, 1).sum; }
    for (const rid in T) { const t4 = T[rid];
        t4.games = t4.w + t4.l + t4.t;
        t4.eff = (t4.pf + t4.bench) > 0 ? t4.pf / (t4.pf + t4.bench) : 1;
        const apG = t4.apW + t4.apL;
        t4.expWins = apG ? (t4.apW / apG) * t4.games : 0;
        t4.luck = t4.w + 0.5 * t4.t - t4.expWins;
        t4.benchWeeks.sort((a, b) => b.lost - a.lost);
        t4.adds.sort((a, b) => b.pts - a.pts);
        t4.drops.sort((a, b) => b.pts - a.pts);
        t4.draftPts = draftPts[rid] || 0;
    }
    return { weeks, T };
}
function ledgerBody() {
    if (!S.seasonLedger) {
        if (!S.seasonLedgerBusy) { S.seasonLedgerBusy = true; ensureLedgerData().then(() => { S.seasonLedger = ledgerCompute(); S.seasonLedgerBusy = false; render(); }).catch(() => { S.seasonLedgerBusy = false; }); }
        return h('div', { class: 'cap' }, h('span', { class: 'spin' }), 'Reading the season back…');
    }
    const L = S.seasonLedger; if (!L) return h('div', { class: 'empty' }, 'No completed weeks to read yet.');
    const rid = S.ui.ledgerTeam || (S.myRoster && S.myRoster.roster_id) || S.rosters[0].roster_id;
    const t = L.T[rid]; const R = rosterById(rid); const mine = S.myRoster && rid === S.myRoster.roster_id;
    const rank = (key, dir) => Object.values(L.T).slice().sort((a, b) => dir === 'asc' ? a[key] - b[key] : b[key] - a[key]).findIndex(x => x.rid === rid) + 1;
    const apPct = (x) => (x.apW + x.apL) ? x.apW / (x.apW + x.apL) : 0;
    const apRank = Object.values(L.T).slice().sort((a, b) => apPct(b) - apPct(a)).findIndex(x => x.rid === rid) + 1;
    const wk = (b) => `wk ${b.w}`;
    const who = h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, avatarEl(R, 'sm'), h('b', null, mine ? 'Your ledger' : `${teamName(R)}'s ledger`), h('span', { class: 'dim', style: 'font-size:11.5px' }, `weeks 1–${L.weeks[L.weeks.length - 1]} · click a row below to read a rival`));
    const cards = h('div', { class: 'ledgrid' },
        h('div', { class: 'card2 ledcard' },
            h('div', { class: 'muted lbl2' }, 'RECORD VS ALL-PLAY'),
            h('div', { style: 'display:flex;align-items:baseline;gap:8px' }, h('b', { class: 'mono', style: 'font-size:20px' }, `${t.w}–${t.l}${t.t ? '–' + t.t : ''}`), h('span', { class: 'dim' }, `actual · ${ordinal(rank('w', 'desc'))}`)),
            h('div', { style: 'display:flex;align-items:baseline;gap:8px' }, h('b', { class: 'mono teal', style: 'font-size:20px' }, `${Math.round(t.apW)}–${Math.round(t.apL)}`), h('span', { class: 'dim' }, `all-play · ${ordinal(apRank)}`)),
            h('div', { class: 'dim', style: 'font-size:11.5px;margin-top:6px' }, `Luck: `, h('b', { class: t.luck < -0.5 ? 'amber' : t.luck > 0.5 ? 'green' : '' }, `${t.luck > 0 ? '+' : ''}${t.luck.toFixed(1)} wins`), ` vs an average schedule.`)),
        h('div', { class: 'card2 ledcard' },
            h('div', { class: 'muted lbl2' }, 'LEFT ON THE BENCH'),
            h('div', { style: 'display:flex;align-items:baseline;gap:8px' }, h('b', { class: 'mono red', style: 'font-size:20px' }, fmt1(t.bench)), h('span', { class: 'dim' }, `points · ${ordinal(rank('bench', 'asc'))} best`), h('span', { class: 'mono dim', title: 'Efficiency: points scored ÷ the best legal lineup — the bench, normalized for how much you score' }, `· eff ${(t.eff * 100).toFixed(1)}%`)),
            h('div', { class: 'mono dim', style: 'font-size:11px;line-height:1.8;margin-top:4px' },
                ...t.benchWeeks.slice(0, 3).map(b => h('div', null, `${wk(b)} `, h('span', { class: 'red' }, `−${fmt1(b.lost)}`), b.sat ? ` sat ${(P(b.sat) || {}).last_name || pname(b.sat)} (${fmt1(b.satPts)})` : '')),
                t.benchWeeks.length ? null : h('div', null, 'Not a point wasted.'))),
        h('div', { class: 'card2 ledcard' },
            h('div', { class: 'muted lbl2' }, 'MOVES & THE DRAFT'),
            h('div', { style: 'font-size:12px;line-height:1.8' },
                t.adds.length ? h('div', null, h('span', { class: 'chip green', style: 'font-size:9.5px;margin-right:6px' }, 'BEST ADD'), h('b', null, (P(t.adds[0].pid) || {}).last_name || pname(t.adds[0].pid)), t.adds[0].bid != null ? h('span', { class: 'dim' }, ` $${t.adds[0].bid}`) : null, h('span', { class: 'dim' }, ` wk ${t.adds[0].w} → `), h('b', { class: 'mono green' }, `${fmt1(t.adds[0].pts)} started`)) : h('div', { class: 'dim' }, 'No pickup ever cracked the lineup.'),
                t.drops.length ? h('div', null, h('span', { class: 'chip red', style: 'font-size:9.5px;margin-right:6px' }, 'WORST DROP'), h('b', null, (P(t.drops[0].pid) || {}).last_name || pname(t.drops[0].pid)), h('span', { class: 'dim' }, ` wk ${t.drops[0].w} → `), h('b', { class: 'mono red' }, `${fmt1(t.drops[0].pts)} elsewhere`)) : h('div', { class: 'dim' }, 'Nothing dropped came back to haunt.')),
            h('div', { class: 'dim', style: 'font-size:11.5px;margin-top:6px' }, `Draft class: `, h('b', { class: 'mono', style: 'color:var(--ink)' }, fmt1(t.draftPts)), ` started points · ${ordinal(rank('draftPts', 'desc'))} in the league.`)));
    // The full season sheet: the standings' scoreboard columns, then the
    // verdicts — one table to settle every December argument.
    const hasDiv = ((S.league.settings || {}).divisions || 0) >= 2;
    const tbl = h('table', null,
        h('tr', null, ...[['Team'], ['W–L'], hasDiv ? ['Div', 'Record against your own division'] : null, ['All-play', 'Record with the schedule removed'], ['PF'], ['PA'],
            ['Luck', 'Actual wins minus all-play expectation'], ['Bench lost', 'Points a better lineup call would have kept'], ['Eff', 'Points scored ÷ best legal lineup — the bench, normalized'], ['Draft pts', 'Points your draft picks started for you']]
            .filter(Boolean).map(([c, tt], i) => h('th', { class: i ? 'r' : '', title: tt || null }, c))),
        ...Object.values(L.T).sort((a, b) => apPct(b) - apPct(a)).map(x => {
            const XR = rosterById(x.rid); const on = x.rid === rid;
            return h('tr', { class: on ? 'hl' : '', style: 'cursor:pointer', onclick: () => { S.ui.ledgerTeam = x.rid; render(); } },
                h('td', null, h('div', { style: 'display:flex;align-items:center;gap:7px' }, avatarEl(XR, 'sm'), h('b', { class: S.myRoster && x.rid === S.myRoster.roster_id ? 'teal' : '' }, teamName(XR)))),
                h('td', { class: 'r mono' }, `${x.w}–${x.l}${x.t ? '–' + x.t : ''}`),
                hasDiv ? h('td', { class: 'r mono dim' }, (x.dw + x.dl + x.dt) ? `${x.dw}–${x.dl}${x.dt ? '–' + x.dt : ''}` : '—') : null,
                h('td', { class: 'r mono' }, `${Math.round(x.apW)}–${Math.round(x.apL)}`),
                h('td', { class: 'r mono' }, fmt1(x.pf)),
                h('td', { class: 'r mono dim' }, fmt1(x.pa)),
                h('td', { class: `r mono ${x.luck < -0.5 ? 'amber' : x.luck > 0.5 ? 'green' : 'dim'}` }, `${x.luck > 0 ? '+' : ''}${x.luck.toFixed(1)}`),
                h('td', { class: 'r mono red' }, fmt1(x.bench)),
                h('td', { class: `r mono ${x.eff >= 0.95 ? 'green' : x.eff < 0.9 ? 'amber' : 'dim'}` }, `${(x.eff * 100).toFixed(1)}%`),
                h('td', { class: 'r mono' }, fmt1(x.draftPts)));
        }));
    return h('div', null, who, cards, h('div', { class: 'scroll-x', style: 'margin-top:12px' }, tbl));
}

// ── pages ────────────────────────────────────────────────────────────────────
function pageHome() {
    const page = h('div', { class: 'page home2' });
    const bot = homeBottomCard();
    if ((S.ui.homeBot || 'standings') === 'ledger') page.append(doBanner(), h('div', { class: 'hleft' }, homeTopCard()), pulseCard(), bot);
    else page.append(doBanner(), h('div', { class: 'hleft' }, homeTopCard(), bot), pulseCard());
    return page;
}
// ── the DO line ──────────────────────────────────────────────────────────────
// A terminal prompt for your team: one token per thing you can own a count of
// — slots filled, players Q, dollars, claims, offers — and the week's deadline
// at the right. Nothing on the line is an *answer*; answers (who the cover is,
// which free agent fills the hole) live in the rows underneath, which open by
// themselves when something is red and filter to one token when you click it.
const DO_KEYS = ['lineup', 'q', 'bench', 'roster', 'ir', 'faab', 'claims', 'offers', 'review', 'byes'];
// The bench player who plays LATEST after this one — the man who can still go
// in after a Questionable starter is ruled out. Same rule as the insights
// engine's cover, recomputed here because the engine only names one insight
// per player and a Q starter can be outranked by a bigger one.
function lateCover(pid, slot) {
    const my = S.myRoster, k = insKickInfo(pid);
    if (!my || !k) return null;
    const sk = Date.parse(k.t); if (!isFinite(sk)) return null;
    const started = new Set((my.starters || []).filter(x => x && x !== '0'));
    const elig = FLEX[slot];
    let best = null, bt = 0;
    for (const b of my.players || []) {
        if (started.has(b) || (my.reserve || []).includes(b) || (my.taxi || []).includes(b)) continue;
        const pos = ppos(b);
        if (elig ? !elig.includes(pos) : pos !== slot) continue;
        if (isBye(b, S.week) || INS_NO_PLAY.test((insNormStatus(statusOf(b)) || '').toLowerCase())) continue;
        const bk = insKickInfo(b); if (!bk) continue;
        const t = Date.parse(bk.t);
        if (isFinite(t) && t > sk && t > bt) { best = b; bt = t; }
    }
    return best ? { pid: best, ts: bt } : null;
}
// The week's first kickoff, and what it has become.
function weekKick() {
    let first = null, live = false, over = 0, n = 0;
    const seen = new Set();
    for (const t in (kickMap() || {})) {
        const g = S.kick[t]; if (!g || seen.has(g)) continue; seen.add(g);
        const ts = Date.parse(g.t); if (!isFinite(ts)) continue;
        n++; if (g.over) over++; if (g.live || (g.started && !g.over)) live = true;
        if (first == null || ts < first) first = ts;
    }
    if (first == null) return null;
    return { ts: first, live, done: n > 0 && over === n };
}
const dayTime = (ts) => { const d = new Date(ts), hr = d.getHours() % 12 || 12, mn = String(d.getMinutes()).padStart(2, '0'); return `${DAY[d.getDay()].toUpperCase()} ${hr}:${mn}${d.getHours() < 12 ? 'a' : 'p'}`; };
function countdown(ms) {
    if (ms <= 0) return null;
    const h1 = Math.floor(ms / 3600e3), d = Math.floor(h1 / 24);
    return d >= 1 ? `${d}d ${h1 % 24}h` : h1 >= 1 ? `${h1}h ${Math.floor((ms % 3600e3) / 60e3)}m` : `${Math.max(1, Math.floor(ms / 60e3))}m`;
}
// Every token, with the rows that open under it. sev: r red, a amber, t teal,
// g green, '' quiet. A token with no rows is a signpost — clicking it navigates.
function doTokens(my) {
    const INS = insightsIndex(my);
    const slots = starterSlots(), st = S.league.settings || {};
    const mm = myMatchup(S.week);
    const margin = mm && mm.opp ? muProjected(my, mm.mine) - muProjected(rosterById(mm.opp.roster_id), mm.opp) : null;
    const payoff = (d) => { if (margin == null || !d) return null; const after = margin + d; return after >= 0 ? `→ lead by ${fmt1(after)}` : `→ still down ${fmt1(-after)}`; };
    const last = (pid) => (P(pid) || {}).last_name || pname(pid);
    const T = {};
    for (const k of DO_KEYS) T[k] = { key: k, rows: [], sev: '' };

    // LINEUP — slots that will actually score, of slots you must fill. A slot
    // whose game has kicked off is no longer a to-do: it is a result, and the
    // row says so instead of offering a button that can't help.
    const wk = weekKick();
    const openSpots = openRosterSlots();
    const costsDrop = openSpots <= 0 ? ' — the roster is full, so someone has to go' : '';
    let bad = 0, fixable = 0;
    slots.forEach((slot, i) => {
        const pid = (my.starters || [])[i];
        if (!pid || pid === '0') {
            bad++;
            const shut = !!(wk && wk.done);
            if (!shut) fixable++;
            const ins = INS[`slot:${i}`] || {};
            const fa = /best FA: (.+) (\d[\d.]*)$/.exec(ins.text || '');
            const word = slot === 'K' ? 'kicker' : slot === 'DEF' ? 'defense' : slotLabel(slot);
            T.lineup.rows.push({
                name: `${slotLabel(slot)} is empty`, sev: 'r',
                fact: shut ? `the week is over — that slot scored 0.0`
                    : fa ? `${fa[1]} is on the wire, ${fa[2]} projected${costsDrop}` : `nothing in your ${word} slot${costsDrop}`,
                pay: !shut && fa ? payoff(Number(fa[2])) : null, btn: shut ? null : 'ADD',
                fn: () => { S.ui.playersTab = 'available'; if (!FLEX[slot]) S.ui.playersPos = slot; go('players'); }
            });
            return;
        }
        const sx = insNormStatus(statusOf(pid));
        if (isBye(pid, S.week) || (sx && INS_NO_PLAY.test(sx.toLowerCase()) && !playedWeek(pid, S.week))) {
            bad++;
            const k = insKickInfo(pid), locked = !!(k && (k.started || k.over));
            if (!locked) fixable++;
            const why = isBye(pid, S.week) ? 'on bye' : sx.toUpperCase();
            T.lineup.rows.push({
                name: `${last(pid)} won't play`, sev: 'r',
                fact: locked ? `${why} — his game kicked off ${k ? dayTime(Date.parse(k.t)) : 'already'}, so ${slotLabel(slot)} is stuck on 0.0`
                    : `${why} · ${slotLabel(slot)} scores 0.0`,
                btn: locked ? null : 'FIX', fn: () => go('team')
            });
        }
    });
    T.lineup.val = `${slots.length - bad}/${slots.length}`;
    T.lineup.sev = fixable ? 'r' : bad ? 'a' : 'g';
    if (!bad) T.lineup.go = () => go('team');

    // Q — questionable starters, each with the man who plays after him
    let qn = 0;
    slots.forEach((slot, i) => {
        const pid = (my.starters || [])[i]; if (!pid || pid === '0') return;
        const sx = insNormStatus(statusOf(pid)); if (!sx || !INS_MAYBE.test(sx.toLowerCase())) return;
        const k = insKickInfo(pid); if (k && (k.started || k.over)) return;   // already playing: not a decision
        qn++;
        const cov = lateCover(pid, slot);
        const when = k ? dayTime(Date.parse(k.t)) : 'kickoff unknown';
        T.q.rows.push({
            name: `${last(pid)} is ${sx === 'Doubtful' ? 'doubtful' : 'questionable'}`, sev: 'a',
            fact: cov ? `plays ${when} — if he sits, ${last(cov.pid)} (${dayTime(cov.ts)}) can still go in after`
                : `plays ${when} — nobody on your bench plays later, so decide before then`,
            btn: cov ? 'PLAN' : 'SHOP',
            fn: cov ? () => { S.ui.swapFrom = { type: 'bench', pid: cov.pid }; go('team'); }
                : () => { S.ui.playersTab = 'available'; if (!FLEX[slot]) S.ui.playersPos = slot; go('players'); }
        });
    });
    T.q.val = String(qn); T.q.sev = qn ? 'a' : '';
    if (!qn) T.q.go = () => go('team');

    // BENCH — a bench player out-projecting the starter he could replace
    for (const ref in INS) {
        const ins = INS[ref];
        if (ins.type !== 'out_projected') continue;
        const bp = ins.action && ins.action.target_ref;
        T.bench.rows.push({ name: `${last(bp)} over ${last(ref)}`, sev: 'a', fact: `${ins.text.replace(/^\S+\s(?:projects\s)?/, 'projects ')} in your lineup`, btn: 'SWAP', fn: () => { S.ui.swapFrom = { type: 'bench', pid: bp }; go('team'); } });
    }
    T.bench.val = String(T.bench.rows.length); T.bench.sev = T.bench.rows.length ? 'a' : '';
    if (!T.bench.rows.length) T.bench.go = () => go('team');

    // ROSTER — active spots filled of spots you have. An empty one is a free
    // pickup you are not making; it costs nothing but the claim.
    const cap = rosterPositions().filter(p => p !== 'IR' && p !== 'TAXI').length;
    T.roster.val = `${cap - openSpots}/${cap}`;
    // While you have claims in, they are already filling the open spots: the row would only say so again.
    const claiming = S.pending.some(x => x.type === 'waiver' && (x.roster_ids || []).includes(my.roster_id));
    if (openSpots > 0 && !claiming) {
        T.roster.sev = 't';
        T.roster.rows.push({ name: `${openSpots} open roster spot${openSpots === 1 ? '' : 's'}`, sev: 't', fact: `nobody has to be dropped — a pickup costs you the claim and nothing else`, btn: 'SHOP', fn: () => go('players', { playersTab: 'available' }) });
    } else T.roster.go = () => go('team');

    // IR — slots used, anyone eligible for one standing open, and anyone who
    // has healed and is still sitting there: Sleeper blocks every roster move
    // until he comes off, so that one is red.
    const irSlots = st.reserve_slots || 0;
    if (irSlots > 0) {
        const used = (my.reserve || []).length;
        T.ir.val = `${used}/${irSlots}`;
        for (const pid of my.reserve || []) {
            if (irStatusOk(pid)) continue;
            const sx = insNormStatus(statusOf(pid));
            T.ir.rows.push({ name: `${last(pid)} is off IR`, sev: 'r', fact: `${sx ? sx.toLowerCase() : 'healthy'} — Sleeper blocks every roster move until you activate or drop him`, btn: 'FIX', fn: () => go('team') });
        }
        for (const ref in INS) if (INS[ref].type === 'ir_candidate') T.ir.rows.push({ name: `${last(ref)} is IR-eligible`, sev: 'a', fact: `an IR slot is open — stashing him frees an active spot`, btn: 'MOVE', fn: () => go('team') });
        T.ir.sev = T.ir.rows.some(r => r.sev === 'r') ? 'r' : T.ir.rows.length ? 'a' : '';
        if (!T.ir.rows.length) T.ir.go = () => go('team');
    } else T.ir.hide = true;

    // FAAB / waiver position — money is never a problem, so never coloured
    const wi = waiverInfo();
    T.faab.val = wi.faab ? `$${faabLeft(my)}` : `#${my.settings.waiver_position}`;
    T.faab.label = wi.faab ? 'FAAB' : 'WAIVER';
    T.faab.go = () => go('players', { playersTab: 'available' });

    // CLAIMS — how many you have in, and when they run. The claims themselves, and how the last run went, are the
    // Transactions drawer's: a row per claim here was the drawer said twice (the user, 2026-10-13: "I dont need you
    // to redisplay all the damn waiver bids").
    const claims = S.pending.filter(x => x.type === 'waiver' && (x.roster_ids || []).includes(my.roster_id));
    T.claims.val = String(claims.length); T.claims.sev = claims.length ? 't' : '';
    T.claims.go = claims.length ? () => openTx({ tab: 'waivers' }) : () => go('players', { playersTab: 'available' });
    T.claims.sub = runsWhen();

    // OFFERS — trades waiting on YOU; the ones you sent are not a to-do
    const offers = S.pending.filter(x => x.type === 'trade' && (x.roster_ids || []).includes(my.roster_id) && String(x.creator) !== String(S.myUserId));
    T.offers.val = String(offers.length); T.offers.sev = offers.length ? 'r' : '';
    T.offers.rows = offers.map(o => ({ name: 'Trade offer', sev: 'r', fact: tradeSummary(o).slice(0, 70), btn: 'REVIEW', fn: () => openTx({ tab: 'trades' }) }));
    // The deadline is a week number, so it means nothing until it's close.
    const dl = st.trade_deadline;
    if (dl && dl <= LAST_WEEK) {
        const away = dl - S.week;
        if (away < 0) T.offers.sub = 'closed';
        else if (away <= 2) {
            T.offers.sub = `wk ${dl}`;
            T.offers.rows.push({ name: `Trade deadline week ${dl}`, sev: 'a', fact: away === 0 ? 'this is the last week to make a deal' : `${away} week${away === 1 ? '' : 's'} left to make a deal`, btn: 'TRADE', fn: () => go('team') });
            if (!offers.length) T.offers.sev = 'a';
        }
    }
    if (!offers.length && !T.offers.rows.length) T.offers.go = () => go('team');

    // REVIEW — for the commissioner: a trade both teams accepted is a decision only you can make
    const inReview = reviewTrades();
    if (!amCommish()) T.review.hide = true;
    else {
        T.review.val = String(inReview.length); T.review.sev = inReview.length ? 'a' : '';
        T.review.rows = inReview.map(t => ({ name: 'Trade in review', sev: 'a', fact: `${(t.roster_ids || []).map(r => teamName(rosterById(r))).join(' ⇄ ')} · goes through ${atWhen(reviewEnds(t))} unless you act`, btn: 'REVIEW', fn: () => openTx({ tab: 'trades', tpart: 'review' }) }));
        if (!inReview.length) T.review.go = () => openTx({ tab: 'trades', tpart: 'review' });
    }

    // BYES — the first week two or more of your starters are gone at once
    const byes = byeCalendar(my).find(b => b.who.length >= 2);
    if (byes) {
        T.byes.val = `WK ${byes.w}`; T.byes.sev = 'a';
        T.byes.rows.push({ name: `Week ${byes.w}`, sev: 'a', fact: `${byes.who.join(', ')} are all on bye`, btn: 'PLAN', fn: () => go('team') });
    } else T.byes.hide = true;

    const LBL = { lineup: 'LINEUP', q: 'Q', bench: 'BENCH▲', roster: 'ROSTER', ir: 'IR', faab: 'FAAB', claims: 'CLAIMS', offers: 'OFFERS', review: 'REVIEW', byes: 'BYES' };
    return DO_KEYS.filter(k => !T[k].hide).map(k => Object.assign({ label: LBL[k] }, T[k]));
}
function doBanner() {
    const my = S.myRoster;
    if (!my) return h('div', { class: 'card hb' }, h('div', { class: 'dim' }, 'You are not a manager in this league — the rest of the league is below.'));
    const toks = doTokens(my), kick = weekKick();
    const hot = toks.some(t => t.sev === 'r');
    // It opens itself when something is red — or when something amber is inside
    // a day of kickoff, which is when an amber thing stops being a someday.
    const soon = kick && !kick.live && !kick.done && kick.ts - Date.now() < 24 * 3600e3;
    const auto = hot || !!(soon && toks.some(t => t.sev === 'a'));
    const open = S.ui.doOpen == null ? auto : S.ui.doOpen;
    const sel = toks.some(t => t.key === S.ui.doTok && t.rows.length) ? S.ui.doTok : null;
    const pick = (t) => {
        if (!t.rows.length) { if (t.go) t.go(); return; }
        if (sel === t.key && open) { S.ui.doTok = null; S.ui.doOpen = false; }
        else { S.ui.doTok = t.key; S.ui.doOpen = true; }
        render();
    };
    const line = h('div', { class: 'dostat' }, ...toks.map(t => h('span', {
        class: `dotok ${t.sev}${sel === t.key && open ? ' on' : ''}${t.rows.length ? ' has' : ''}`,
        title: t.rows.length ? `${t.rows.length} thing${t.rows.length === 1 ? '' : 's'} — click to open` : 'nothing here',
        onclick: () => pick(t)
    }, h('i', null, t.label || t.key.toUpperCase()), h('b', null, t.val), t.sub ? h('u', null, t.sub) : null)));
    if (kick) {
        const cd = countdown(kick.ts - Date.now());
        line.append(h('span', { class: 'doclk' }, h('i', null, kick.done ? 'WEEK' : kick.live ? 'GAMES' : 'KICKOFF'),
            h('b', null, kick.done ? 'FINAL' : kick.live ? 'LIVE' : dayTime(kick.ts)), !kick.live && !kick.done && cd ? h('u', null, cd) : null));
    }
    const any = toks.some(t => t.rows.length);
    line.append(h('span', {
        class: `dochev${any ? '' : ' none'}`, title: any ? (open ? 'fold' : 'show everything') : 'nothing to show',
        onclick: () => { if (!any) return; S.ui.doTok = null; S.ui.doOpen = !open; render(); }
    }, any ? caret('', open) : '✓'));
    const card = h('div', { class: `card hb docard ${hot ? 'hot' : ''}` }, line);
    if (open && any) {
        const rows = [];
        for (const t of toks) {
            if (sel && t.key !== sel) continue;
            for (const r of t.rows) rows.push(h('div', { class: 'dorow' },
                h('span', { class: 'dok' }, t.label || t.key.toUpperCase()),
                h('b', { class: r.sev === 'r' ? 'red' : '' }, r.name),
                h('span', { class: 'dof' }, `— ${r.fact}`),
                r.pay ? h('span', { class: 'pay' }, r.pay) : null,
                r.btn ? h('span', { class: 'go', onclick: r.fn }, r.btn) : h('span', { class: 'domiss' }, 'TOO LATE')));
        }
        card.append(h('div', { class: 'dodraw' }, ...rows));
    }
    return card;
}
// ── the two toggle cards: My matchup / Scoreboard, Standings / Schedule ──────
function homeTopCard() {
    const tab = S.ui.homeTop || 'matchup';
    const card = h('div', { class: 'card' });
    card.append(h('div', { class: 'card-h' },
        h('div', { class: 'tabs' }, ...[['matchup', 'My matchup'], ['scoreboard', 'Scoreboard']].map(([k, tt]) => h('span', { class: k === tab ? 'on' : '', onclick: () => { S.ui.homeTop = k; render(); } }, tt))),
        tab === 'matchup' ? h('span', { class: 'lnk', onclick: () => go('matchup') }, 'Full matchup →')
            : null));
    const tw = tab === 'matchup' ? turnWeek() : null;
    if (tw && myMatchup(tw) && S.myRoster) {
        card.firstChild.lastChild && card.firstChild.lastChild.remove();
        card.firstChild.append(h('span', { class: 'lnk', onclick: () => go('matchup') }, `Week ${tw} recap \u2192`));
        card.append(weekTurnBody(tw));
    } else if (tab === 'matchup') card.append(matchupHeader(S.myRoster, true));
    else card.append(h('div', { class: 'tilegrid' }, matchupTiles((myMatchup(S.week) || { mine: {} }).mine.matchup_id, (rid) => { S.ui.matchupRoster = rid; go('matchup'); })));
    return card;
}
// The turn of the week, in one card: how the finished week ended on the left,
// the next matchup and what to fix before it on the right.
function weekTurnBody(tw) {
    const my = S.myRoster, mm = myMatchup(tw);
    const B = mm.opp ? rosterById(mm.opp.roster_id) : null;
    const a = mm.mine.points || 0, b = mm.opp ? mm.opp.points || 0 : 0;
    const verdict = !mm.opp ? 'Bye' : a > b ? 'Won' : a < b ? 'Lost' : 'Tied';
    const pp = mm.mine.players_points || {};
    const starters = (mm.mine.starters || []).filter(pid => pid && pid !== '0');
    const best = starters.slice().sort((x, y) => (pp[y] || 0) - (pp[x] || 0))[0];
    const hurt = starters.map(pid => ({ pid, pts: pp[pid] || 0, proj: projOf(pid, tw) }))
        .filter(x => x.proj != null && x.proj - x.pts >= 5).sort((x, y) => (y.proj - y.pts) - (x.proj - x.pts))[0];
    const V = poView();
    const rank = rosterRank().findIndex(r => r.roster_id === my.roster_id) + 1;
    const left = h('div', { class: 'wtleft' },
        h('div', { class: 'wteye' }, `Week ${tw} \u00b7 final`),
        h('div', { class: 'wtres' }, h('b', { class: verdict === 'Won' ? 'green' : verdict === 'Lost' ? 'red' : '' }, verdict), mm.opp ? h('span', { class: 'mono' }, ` ${fmtS(a)}\u2013${fmtS(b)}`) : null),
        B ? h('div', { class: 'muted', style: 'font-size:12.5px' }, `to ${teamName(B)}`) : null,
        h('div', { class: 'wtlist' },
            h('div', null, h('span', { class: 'chip' }, record(my)), ` ${ordinal(rank)} of ${S.rosters.length}${V && V.inP != null ? ` \u00b7 ${V.inP}% to make the ${V.playoffTeams}` : ''}`),
            best ? h('div', null, h('span', { class: 'chip' }, 'best'), ` ${pname(best)} ${fmtS(pp[best] || 0)}`) : null,
            hurt ? h('div', null, h('span', { class: 'chip red' }, 'hurt you'), ` ${pname(hurt.pid)} ${fmtS(hurt.pts)} on ${fmtS(hurt.proj)} proj`) : null));
    // what to fix before the next kickoff: empty or dead slots, then questionable starters
    const INS = insightsIndex(my);
    const todo = [];
    starterSlots().forEach((slot, i) => {
        const pid = (my.starters || [])[i];
        if (!pid || pid === '0') {
            const ins = INS['slot:' + i]; const fa = /best FA: (.+) (\d[\d.]*)$/.exec((ins && ins.text) || '');
            todo.push(h('div', null, h('span', { class: 'chip red' }, `${slotLabel(slot)} empty`), fa ? ` best on the wire: ${fa[1]}, ${fa[2]} proj` : ' nothing in that slot',
                h('span', { class: 'lnk', style: 'margin-left:auto', onclick: () => { S.ui.playersTab = 'available'; if (!FLEX[slot]) S.ui.playersPos = slot; go('players'); } }, 'Find one \u2192')));
            return;
        }
        const sx = insNormStatus(statusOf(pid));
        if (isBye(pid, S.week)) todo.push(h('div', null, h('span', { class: 'chip red' }, 'BYE'), ` ${pname(pid)} is on bye`));
        else if (sx && INS_NO_PLAY.test(sx.toLowerCase()) && !playedWeek(pid, S.week)) todo.push(h('div', null, h('span', { class: 'chip red' }, sx.toUpperCase()), ` ${pname(pid)} won\u2019t play`));
        else if (sx && INS_MAYBE.test(sx.toLowerCase())) { const g = gameOf(pid, S.week); todo.push(h('div', null, h('span', { class: 'chip amber' }, sx[0]), ` ${pname(pid)} is ${sx.toLowerCase()}${g ? `, ${g.home ? 'vs ' : '@'}${g.opp}${kickoffLabel((P(pid) || {}).team) ? ' ' + kickoffLabel((P(pid) || {}).team) : ''}` : ''}`)); }
    });
    const right = h('div', { class: 'wtright' },
        h('div', { class: 'wteye' }, `Week ${S.week} \u00b7 next`),
        turnPreview(my),
        todo.length ? h('div', { class: 'wtlist' }, ...todo.slice(0, 3)) : h('div', { class: 'wtlist' }, h('div', { class: 'dim' }, h('span', { class: 'chip green' }, 'set'), ' Every slot filled, and nobody on bye, out or questionable.')));
    return h('div', { class: 'wtsplit' }, left, right);
}
// Next week's matchup as two stacked rows — team, record and rank, projection —
// because the side-by-side hero needs the whole card's width.
function turnPreview(my) {
    const mm = myMatchup(S.week);
    if (!mm) return h('div', { class: 'dim', style: 'font-size:12.5px' }, S.matchups[S.week] ? 'No matchup next week.' : 'Loading next week\u2026');
    const B = mm.opp ? rosterById(mm.opp.roster_id) : null;
    const pA = muProjected(my, mm.mine), pB = B ? muProjected(B, mm.opp) : null;
    const rank = (R) => ordinal(rosterRank().findIndex(r => r.roster_id === R.roster_id) + 1);
    const row = (R, p, lead, cls) => h('div', { class: `tprow ${cls}` }, avatarEl(R), h('div', { class: 'tpnm' }, h('b', null, teamName(R)), h('small', null, `${record(R)} \u00b7 ${rank(R)}`)), h('span', { class: `tpp mono${lead ? '' : ' trail'}` }, fmtS(p)));
    return h('div', { class: 'tprev' },
        h('div', { class: 'tplab' }, 'PROJECTED'),
        row(my, pA, pB == null || pA >= pB, 'a'),
        B ? row(B, pB, pB > pA, 'b') : h('div', { class: 'dim' }, 'Bye'));
}
function homeBottomCard() {
    const ledgerOK = S.curWeek > regSeasonEnd() || S.ledgerForce;
    let tab = S.ui.homeBot || 'standings';
    if (tab === 'ledger' && !ledgerOK) tab = 'standings';
    const tabs = [['standings', 'Standings'], ['schedule', 'Schedule']];
    if (ledgerOK) tabs.push(['ledger', '\u{1F4D2} Ledger']);
    const card = h('div', { class: 'card' + (tab === 'ledger' ? ' hb' : '') });
    card.append(h('div', { class: 'card-h' },
        h('div', { class: 'tabs' }, ...tabs.map(([k, tt]) => h('span', { class: k === tab ? 'on' : '', onclick: () => { S.ui.homeBot = k; if (k === 'schedule') loadSeasonMatchups(); render(); } }, tt))),
        tab === 'ledger' ? h('span', { class: 'dim', style: 'font-size:12px' }, 'regular season, settled with numbers') : null,
        tab === 'standings' ? liveSwitch('homelive') : null));
    if (tab === 'standings') card.append(...poLine(), standingsTable(true));
    else if (tab === 'ledger') card.append(ledgerBody());
    else card.append(myScheduleTable());
    return card;
}
function regSeasonEnd() { return Math.min(LAST_WEEK, (((S.league || {}).settings || {}).playoff_week_start || LAST_WEEK + 1) - 1); }
function loadSeasonMatchups() {
    // schedule AND efficiency want these. Only the caller that starts a week's read redraws when it
    // lands: this runs on every redraw, and each one used to queue its own redraw behind every week.
    for (let w2 = 1; w2 <= regSeasonEnd(); w2++) if (!S.matchups[w2] && !inflight.has(`matchups:${w2}`)) loadMatchups(w2).then((got) => { if (got) render(); });
}
function myScheduleTable() {
    const my = S.myRoster;
    if (!my) return h('div', { class: 'empty' }, 'No team here.');
    const tbl = h('table', null);
    for (let w2 = 1; w2 <= regSeasonEnd(); w2++) {
        const ms = S.matchups[w2];
        let oppEl = h('span', { class: 'dim' }, ms ? 'bye' : '…'), resEl = h('span', { class: 'dim' }, '—');
        if (ms) {
            const mine = ms.find(m => m.roster_id === my.roster_id);
            const opp = mine ? ms.find(m => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id) : null;
            if (opp) {
                const R = rosterById(opp.roster_id);
                const myDiv = (my.settings || {}).division || 0, oDiv = R ? ((R.settings || {}).division || 0) : 0;
                oppEl = h('div', { class: 'tcell' }, avatarEl(R, 'sm'),
                    h('span', { style: 'cursor:pointer;font-weight:700;overflow:hidden;text-overflow:ellipsis', onclick: () => { setWeek(w2); S.ui.matchupRoster = my.roster_id; go('matchup'); } }, R ? teamName(R) : `Roster ${opp.roster_id}`),
                    R ? h('span', { class: 'dim mono', style: 'font-size:11px;flex:none' }, record(R)) : null,
                    myDiv && oDiv === myDiv ? h('span', { class: 'divchip', title: `Division game — ${(S.league.metadata || {})['division_' + myDiv] || 'your division'}` }, 'DIV') : null);
                if (w2 < S.curWeek) {
                    const won = (mine.points || 0) >= (opp.points || 0);
                    resEl = h('span', { class: 'mono', style: `color:var(--${won ? 'green' : 'red'})` }, `${won ? 'W' : 'L'} ${fmt1(mine.points || 0)}–${fmt1(opp.points || 0)}`);
                } else if (w2 === S.curWeek) {
                    const a2 = muProjected(my, mine), b2 = muProjected(R, opp);
                    resEl = h('span', { class: 'mono', style: `color:var(--${a2 >= b2 ? 'green' : 'red'})` }, `proj ${a2 >= b2 ? 'W' : 'L'} ${fmt1(a2)}–${fmt1(b2)}`);
                }
            }
        }
        tbl.append(h('tr', { class: w2 === S.curWeek ? 'hl' : '' }, h('td', { class: 'mono dim', style: 'width:52px' }, `WK ${w2}`), h('td', null, oppEl), h('td', { class: 'r' }, resEl)));
    }
    const st2 = (S.league.settings || {});
    if (st2.playoff_week_start) tbl.append(h('tr', null, h('td', { colspan: 3, class: 'dim', style: 'font-size:11px' }, `Playoffs: ${st2.playoff_teams || '?'} teams from week ${st2.playoff_week_start}`)));
    return h('div', { class: 'scroll-x sttbl' }, tbl);
}
// One player card, shared by the chat drawer and the Pulse feed.
function playerMiniCard(pid, kind, p) {
    pid = String(pid); p = p || P(pid) || {};
    return h('div', { class: `pcard ${kind}`, onclick: (e) => { e.stopPropagation(); if (P(pid)) { S.ui.sel = pid; render(); } } },
        h('div', { class: 'hs' }, h('img', { src: headshot(pid), alt: '', onerror: (e) => e.target.remove() })),
        h('div', null, h('div', { class: 'pn' }, `${p.first_name || ''} ${p.last_name || ''}`.trim() || pname(pid)), h('div', { class: 'ps' }, `${p.position || ppos(pid) || ''} · ${p.team || 'FA'}`)),
        kind === 'block' ? h('span', { class: 'view', onclick: (e) => { e.stopPropagation(); openTx({ tab: 'trades' }); } }, 'VIEW')
            : h('span', { class: 'badge' }, kind === 'add' ? '▲ ADDED' : kind === 'trade' ? '⇄ TRADED' : '▼ DROPPED'));
}
// Sleeper headlines usually re-state the player's name; the row already shows
// it, so drop the lead-in — but never when what follows is a suffix (Sr., III).
function trimHeadline(title, full) {
    title = String(title || '');
    if (!full || !title.startsWith(full)) return title;
    const rest = title.slice(full.length);
    const sep = /^\s*[-–—:·|]\s*/;
    if (sep.test(rest)) return rest.replace(sep, '');
    const m = /^\s+(\S.*)$/.exec(rest);
    if (m && !/^(Sr\.?|Jr\.?|I{2,3}|IV|V)\b/.test(m[1])) return m[1];
    return title;
}
// ── one row for the whole feed ───────────────────────────────────────────────
// News, transactions, league admin and injuries all land in the same column and
// used to be drawn by four renderers with four anatomies: four avatar sizes for
// the same slot, three answers to where the timestamp goes, and a rail on
// exactly one of them (so its colour read as "news is special" rather than
// "this is a WR").
//
// One grid now — rail, avatar, body, stamp — and the SAME horizontal padding
// whether or not the row wears a card, so the stamps line up down the right
// edge either way. The card ground is earned by having a body to hold: a story
// or an injury note gets it, a one-line event stays flat.
function feedRow(o) {
    const kids = (o.body || []).filter(Boolean);
    return h('div', { class: `frow ${kids.length ? 'filled' : ''} ${o.cls || ''}`.trim(), onclick: o.onclick || null },
        h('span', { class: `frail ${o.rail || ''}`.trim() }),
        o.avatar || h('span', { class: 'fav' }),
        h('div', { class: 'fbd' },
            h('div', { class: 'ftitle' }, ...(o.title || [])),
            o.meta ? h('div', { class: 'fmeta' }, ...(Array.isArray(o.meta) ? o.meta : [o.meta])) : null,
            ...kids),
        h('span', { class: 'when' }, o.when));
}
const fHeadshot = (pid) => h('span', { class: 'fav shot' }, h('img', { src: headshot(pid), alt: '', onerror: (e) => e.target.remove() }));
const fMark = (url, fallback) => h('span', { class: 'fav' }, url
    ? h('img', { src: url, alt: '', onerror: (e) => { e.target.parentElement.textContent = fallback; } })
    : document.createTextNode(fallback));
// PlayerNews has six fields and none of them is a display name. `source` is a
// machine key (fantasy_pros), and `source_key` is the PUBLISHER'S ARTICLE ID —
// 220070, different for every story — so it is no help at all. The label is
// ours to write; metadata.url gives a real hostname for anything new.
const NEWS_SOURCES = { rotoballer: 'RotoBaller', rotowire: 'RotoWire', fantasy_pros: 'FantasyPros' };
const sourceKey = (n) => String((n && n.source) || '').toLowerCase().trim();
function sourceLabel(n) {
    const k = sourceKey(n);
    if (NEWS_SOURCES[k]) return NEWS_SOURCES[k];
    const u = n && n.metadata && n.metadata.url;
    if (u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { /* fall through */ } }
    return k ? k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Sleeper';
}
function mutedSources() {
    if (S.ui.mutedSrc) return S.ui.mutedSrc;
    let v = [];
    try { v = JSON.parse(localStorage.getItem('badgerMutedSources') || '[]'); } catch (e) {}
    return (S.ui.mutedSrc = new Set(Array.isArray(v) ? v : []));
}
// A mute that resets on reload is worse than no mute.
function toggleMuteSource(k) {
    const m = mutedSources();
    if (m.has(k)) m.delete(k); else m.add(k);
    try { localStorage.setItem('badgerMutedSources', JSON.stringify([...m])); } catch (e) {}
    render();
}
function newsCard(pid, n) {
    const md = n.metadata || {};
    const pl = P(pid) || {};
    const open = S.ui.newsOpen && S.ui.newsOpen.has(pid);
    const toggle = () => { S.ui.newsOpen = S.ui.newsOpen || new Set(); if (open) S.ui.newsOpen.delete(pid); else S.ui.newsOpen.add(pid); render(); };
    const body = (md.description || md.analysis || '').trim();
    const owner = ownerOf(pid);
    const mine = owner && S.myRoster && owner.roster_id === S.myRoster.roster_id;
    const tag = (S.ui.newsScope || 'mine') !== 'mine'
        ? h('span', { class: `own ${mine ? 'mine' : owner ? '' : 'fa'}` }, mine ? 'YOURS' : owner ? teamName(owner).toUpperCase() : 'FREE')
        : null;
    return feedRow({
        rail: (pl.position || '').toUpperCase(),
        avatar: fHeadshot(pid),
        title: [h('span', { class: 'who', onclick: () => { S.ui.sel = pid; render(); } }, pname(pid)), ' \u2014 ', trimHeadline(md.title, pname(pid)), tag],
        // metadata.url is on every RotoBaller and FantasyPros item and on none
        // of RotoWire's, so a linked label also says "there is more to read".
        meta: [
            md.url
                ? h('a', { class: 'srcname srclink', href: md.url, target: '_blank', rel: 'noopener noreferrer', title: 'Read it at the source', onclick: (e) => e.stopPropagation() }, sourceLabel(n), ' \u2197')
                : h('span', { class: 'srcname' }, sourceLabel(n)),
            h('button', { class: 'srcmute', title: `Hide ${sourceLabel(n)} from the feed`, onclick: (e) => { e.stopPropagation(); toggleMuteSource(sourceKey(n)); } }, 'MUTE'),
        ],
        when: ago(n.published),
        body: [
            body ? h('div', { class: `fdek ${open ? '' : 'clamp'}`, onclick: toggle }, body) : null,
            open && md.analysis && md.description ? h('div', { class: 'fdek', style: 'color:var(--ink)' }, md.analysis) : null,
        ],
    });
}
// Sleeper serves news per player only, so league-wide news is a fan-out over
// everyone rostered — batched (loadNews takes 40 at a time) and only once the
// League tab is actually opened.
// Which players a news scope covers. "Available" cannot mean every unrostered
// player in the NFL, so it means the ones worth hearing about: the best
// available by projection, plus whoever the wider Sleeper population is adding.
function newsPidsFor(scope) {
    const rostered = new Set(S.rosters.flatMap(r => r.players || []));
    const mine = new Set(((S.myRoster || {}).players) || []);
    if (scope === 'mine') return [...mine];
    if (scope === 'rostered') return [...rostered].filter(p => !mine.has(p));
    if (scope === 'avail') {
        const pool = S.proj[S.week] || {};
        const best = Object.keys(pool)
            .filter(p => !rostered.has(p) && P(p) && POS_ORDER.includes(ppos(p)))
            .sort((a, b) => (pool[b].pts || 0) - (pool[a].pts || 0)).slice(0, 80);
        const hot = Object.keys(S.trending || {}).filter(p => !rostered.has(p)).slice(0, 40);
        return [...new Set([...best, ...hot])];
    }
    return [...new Set([...rostered, ...newsPidsFor('avail')])];
}
// Sleeper serves news per player only, so anything wider than your own roster
// is a fan-out — batched (loadNews takes 40 a time) and only once that tab is
// actually opened.
async function loadNewsFor(scope) {
    const key = 'newsDone_' + scope;
    if (S[key] || S.newsBusy) return;
    S.newsBusy = true;
    try {
        const pids = newsPidsFor(scope);
        for (let i = 0; i < 10; i++) {
            const before = Object.keys(S.news).length;
            await loadNews(pids);
            if (Object.keys(S.news).length === before) break;
            render();
        }
        S[key] = true;
    } catch (err) { console.warn(TAG, 'news fan-out:', err.message); }
    finally { S.newsBusy = false; render(); }
}
function pulseTxnRow(t) {
    const rid0 = (t.roster_ids || [])[0];
    const R0 = rosterById(rid0);
    let head;
    const cards = [];
    if (t.type === 'trade') {
        head = [h('b', null, 'Trade')];
        for (const rid of (t.roster_ids || [])) {
            const R = rosterById(rid);
            const got = Object.entries(t.adds || {}).filter(([, r]) => r === rid).map(([p]) => p);
            const picks = (t.draft_picks || []).map(normPick).filter(dp => dp.owner_id === rid && dp.previous_owner_id !== rid).map(pickLabel);
            if (!got.length && !picks.length) continue;
            cards.push(h('div', { class: 'tside2' }, h('b', null, R ? teamLink(R) : `Roster ${rid}`), ' gets'));
            for (const p of got) cards.push(playerMiniCard(p, 'trade'));
            if (picks.length) cards.push(h('div', { class: 'tpicks2' }, h('span', { class: 'tarr' }, '⇄ '), picks.join(' · ')));
        }
    } else {
        const verb = t.type === 'waiver' ? (t.status === 'complete' ? 'won a claim' : 'filed a claim') : 'made a roster move';
        // one span for the sentence: a flex parent would eat the leading space,
        // and h() drops nulls that .append() would stringify
        head = [R0 ? h('b', null, teamLink(R0)) : h('b', null, `Roster ${rid0}`), ` ${verb}`,
            t.settings && t.settings.waiver_bid != null ? h('span', { class: 'mono dim' }, ` \u00b7 $${t.settings.waiver_bid}`) : null];
        for (const p of Object.keys(t.adds || {})) cards.push(playerMiniCard(p, 'add'));
        for (const p of Object.keys(t.drops || {})) cards.push(playerMiniCard(p, 'drop'));
    }
    return feedRow({
        rail: 'txn', avatar: fMark(R0 && teamAvatar(R0), '\u{1F311}'),
        title: head, meta: t.type === 'trade' ? 'Trade' : t.type === 'waiver' ? 'Waiver' : 'Transaction',
        when: ago(t.status_updated || t.created), body: cards,
    });
}
// ── the Pulse: news + transactions, one filterable stream ────────────────────
// Injuries are state, not events, so they group by severity rather than time.
// Everything here comes from the player database already in memory — no fetch.
const OUT_RE = /^(out|ir|pup|sus|na|dnr|cov|doubtful)$/i;
function injuryFeed(scope) {
    const rows = newsPidsFor(scope).map(pid => ({ pid, p: P(pid) }))
        .filter(x => x.p && x.p.injury_status && POS_ORDER.includes(x.p.position));
    const starters = new Set(((S.myRoster || {}).starters || []).filter(p => p && p !== '0'));
    const stashed = new Set(S.rosters.flatMap(r => r.reserve || []));
    const at = (pid) => projOf(pid, S.week) || 0;
    const groups = [
        ['out', "WON'T PLAY", rows.filter(x => !stashed.has(x.pid) && OUT_RE.test(x.p.injury_status))],
        ['qq', 'QUESTIONABLE', rows.filter(x => !stashed.has(x.pid) && !OUT_RE.test(x.p.injury_status))],
        ['ok', 'STASHED — IR / PUP', rows.filter(x => stashed.has(x.pid))],
    ];
    const feed = h('div', { class: 'feed' });
    feed.append(h('div', { class: 'fresh' }, `injury data as of ${S.playersAt ? ago(S.playersAt) : '—'} ago`,
        h('span', { class: 'rf', onclick: () => { S.playersBusy = true; render(); loadPlayers(true).then(() => { S.playersBusy = false; render(); toast('Injury data refreshed'); }).catch(() => { S.playersBusy = false; render(); }); } }, S.playersBusy ? 'refreshing…' : 'refresh'),
        rows.length ? h('span', { class: 'dim' }, `· ${rows.length} injured`) : null));
    for (const [cls, label, list] of groups) {
        if (!list.length && cls === 'ok') continue;   // an empty stash is not news; an empty OUT list is
        list.sort((a, b) => at(b.pid) - at(a.pid));
        feed.append(h('div', { class: `isec ${cls}` }, h('span', { class: 'lbl' }, label), h('span', { class: 'ln' }), h('span', { class: 'cnt' }, list.length)));
        if (!list.length) { feed.append(h('div', { class: 'inone' }, cls === 'out' ? 'Nobody here is ruled out.' : 'Nobody here is questionable.')); continue; }
        for (const { pid, p } of list) {
            const owner = ownerOf(pid);
            const isMine = owner && S.myRoster && owner.roster_id === S.myRoster.roster_id;
            const g = gameOf(pid, S.week);
            const st = p.injury_status;
            const starting = starters.has(pid);
            // These rows used to carry NO time at all, so a note from an hour ago
            // and one from Thursday looked identical.
            feed.append(feedRow({
                cls: 'inj', rail: p.position, avatar: fHeadshot(pid),
                onclick: () => { S.ui.sel = pid; render(); },
                title: [h('span', { class: `pos txt ${p.position}` }, posLabel(p.position)), ' ', pname(pid),
                    h('span', { class: `ist ${OUT_RE.test(st) ? 'ir' : 'q'}` }, st === 'Questionable' ? 'Q' : st === 'Doubtful' ? 'D' : st.toUpperCase()),
                    starting ? h('span', { class: 'starter' }, 'STARTER') : null,
                    scope !== 'mine' ? h('span', { class: `own ${isMine ? 'mine' : owner ? '' : 'fa'}` }, isMine ? 'YOURS' : owner ? teamName(owner).toUpperCase() : 'FREE') : null,
                    isMine ? h('span', { class: `risk ${starting ? '' : 'dim'}` }, starting ? fmt1(at(pid)) : 'bench') : null],
                meta: [p.team || 'FA', p.injury_body_part || null, g ? `${g.home ? 'vs' : '@'} ${g.opp}` : isBye(pid, S.week) ? 'bye' : null].filter(Boolean).join(' \u00b7 '),
                when: p.news_updated ? ago(p.news_updated) : (S.playersAt ? ago(S.playersAt) : ''),
                body: [p.injury_notes ? h('div', { class: 'fdek' }, p.injury_notes) : null],
            }));
        }
    }
    return feed;
}
// League admin events — somebody renamed a player, somebody renamed their
// team. Sleeper posts them into the league chat as messages from "sys", where
// they bury actual conversation: in one league, 25 of 50 messages were nickname
// changes. They are not chat, they are league activity, so they belong in the
// feed with the transactions and the news.
//
// Classified off attachment.type, never off the sentence — Sleeper writes the
// text and can reword it whenever it likes.
const ADMIN_ATT = { player_nickname_update: 'nickname', team_name_update: 'team name' };
const attType = (m) => { const a = m && m.attachment; return a && !Array.isArray(a) && typeof a === 'object' ? a.type : null; };
const isAdminMsg = (m) => !!ADMIN_ATT[attType(m)];
// What the chat does NOT carry. The admin events moved to Other; roster moves
// are already the Transactions tab, drawn from the transactions endpoint rather
// than from a chat message, so keeping them here was the same event twice.
const CHAT_HIDE = (m) => isAdminMsg(m) || attType(m) === 'transactions';   // what the Home feed routes elsewhere; the chat itself shows them, folded
// The chat's quiet rows: a roster move ('move') or a name change ('name'). A
// trade is not quiet: it keeps its full card.
function quietKind(m) {
    const t = attType(m);
    if (t === 'player_nickname_update' || t === 'team_name_update') return m.attachment.data ? 'name' : null;
    if (t !== 'transactions' || !Array.isArray(m.attachment.data)) return null;
    for (const txn of m.attachment.data) {
        const by = (txn && txn.transactions_by_roster) || {}, rids = Object.keys(by);
        if (txn && txn.type === 'trade') return null;
        if (rids.length > 1 || rids.some(r => (by[r].added_picks || []).length || (by[r].added_budget || []).length)) return null;
    }
    return 'move';
}
// user_id comes back as a bare number above 2^53, so it has already lost
// precision by the time we see it — never match on it. The display name is
// what Sleeper puts in the text anyway.
const rosterByDisplayName = (name) => {
    if (!name) return null;
    const u = S.users.find(x => x.display_name === name);
    return u ? S.rosters.find(r => String(r.owner_id) === String(u.user_id)) || null : null;
};
function pulseAdminRow(m) {
    const att = m.attachment || {}, d = att.data || {}, kind = ADMIN_ATT[att.type];
    const who = (d.user && d.user.display_name) || m.author_display_name || 'Someone';
    const R = rosterByDisplayName(who);
    const av = (d.user && d.user.metadata && d.user.metadata.avatar) || (d.user && d.user.avatar && avatarUrl(d.user.avatar)) || (R && teamAvatar(R));
    const deent = (x) => String(x || '').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const icon = fMark(av, '\u{1F3F7}');
    const nameEl = R ? h('b', null, teamLink(R)) : h('b', null, who);
    let line;
    if (att.type === 'team_name_update') {
        // Name the PERSON here, not the team: teamLink resolves to the team's
        // current name, which is the new one, so it read "X is now X".
        line = h('span', null, h('b', null, who), ' renamed the team ', h('b', { class: 'teal' }, deent(d.team_name || '')));
    } else {
        // The payload names every player changed, so say who — the chat only
        // ever said "updated some player nicknames on their team".
        const ch = (d.changes || []).filter(c => c && c.player);
        line = h('span', null, nameEl, ch.length ? ' nicknamed ' : ' updated a nickname',
            ...ch.slice(0, 3).flatMap((c, i) => [
                i ? h('span', { class: 'dim' }, ', ') : null,
                h('span', { class: `pos txt ${c.player.position || ''}` }, posLabel(c.player.position)), ' ',
                h('b', null, `${c.player.first_name || ''} ${c.player.last_name || ''}`.trim()),
                ' ', h('span', { class: 'teal' }, `\u201c${deent(c.nickname)}\u201d`)]),
            ch.length > 3 ? h('span', { class: 'dim' }, ` +${ch.length - 3} more`) : null);
    }
    // Same skeleton as pulseTxnRow — .ptxn owns .sic, .pbody, .pt and .when,
    // and the whole sentence stays in ONE span because .pt is a flex parent
    // and would otherwise eat every leading space in it.
    // The stamp rides on the kind line, not beside the sentence: these wrap to
    // three lines and a margin-left:auto timestamp orphans onto one of its own.
    // The kind tag earns its place in All, where these sit among news cards.
    return feedRow({ cls: 'adm', rail: 'adm', avatar: icon, title: [line], meta: kind, when: ago(m.created) });
}
function pulseCard() {
    const tab = S.ui.pulseTab || 'all';
    const scope = S.ui.newsScope || 'mine';
    const items = [];
    if (tab === 'all' || tab === 'txns') {
        const season = tab === 'txns' && S.ui.pulseSeason;
        const src = []; if (season) { for (let i = 1; i <= S.curWeek; i++) src.push(...(S.txns[i] || [])); } else src.push(...(S.txns[S.week] || []), ...(S.txns[S.week - 1] || []));
        for (const x of src.filter(z => z.status === 'complete')) items.push({ ts: x.status_updated || x.created, el: pulseTxnRow(x) });
    }
    if (tab === 'all' || tab === 'other') {
        if (!S.messages.length && !S.msgBusy) { S.msgBusy = true; loadMessages().then(() => { S.msgBusy = false; render(); }).catch(() => { S.msgBusy = false; }); }
        for (const m of S.messages) if (isAdminMsg(m)) items.push({ ts: m.created, el: pulseAdminRow(m) });
    }
    // Muting is for browsing. It does NOT apply to Injuries — hiding a man's
    // knee because of who reported it is a different thing entirely.
    const muted = mutedSources();
    let hiddenBySource = 0;
    if (tab === 'all' || tab === 'news') {
        const wide = tab === 'news' && scope !== 'mine';
        if (wide) loadNewsFor(scope);
        const pids = tab === 'news' ? newsPidsFor(scope) : (((S.myRoster || {}).players) || []);
        for (const pid of pids) {
            const n = S.news[pid]; if (!n) continue;
            // The count is what THIS view would have shown, not the corpus.
            if (muted.has(sourceKey(n))) { hiddenBySource++; continue; }
            items.push({ ts: n.published, el: newsCard(pid, n) });
        }
    }
    items.sort((a, b) => b.ts - a.ts);
    const shown = items.slice(0, tab === 'news' ? 40 : (tab === 'txns' && S.ui.pulseSeason) ? 80 : 25);
    // Clustered by day, with each day's count — a quiet day should look quiet.
    const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
    const label = (ms) => {
        const d = new Date(ms), now = new Date();
        const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
        return days <= 0 ? 'TODAY' : days === 1 ? 'YESTERDAY' : `${DAY[d.getDay()].toUpperCase()} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}`;
    };
    const counts = {}; for (const it of shown) counts[dayOf(it.ts)] = (counts[dayOf(it.ts)] || 0) + 1;
    const feed = h('div', { class: 'feed' });
    let lastDay = null;
    for (const it of shown) {
        const k = dayOf(it.ts);
        if (k !== lastDay) { feed.append(h('div', { class: 'dayrule' }, h('span', { class: 'lbl' }, label(it.ts)), h('span', { class: 'ln' }), h('span', { class: 'cnt' }, counts[k]))); lastDay = k; }
        feed.append(it.el);
    }
    if (!shown.length) feed.append(h('div', { class: 'empty' }, tab === 'news' && S.newsBusy ? 'Gathering news…' : tab === 'other' && S.msgBusy ? 'Reading the league log…' : tab === 'other' ? 'No nickname or team-name changes on record.' : 'Quiet. Nothing yet.'));
    const mutedLine = (muted.size && (tab === 'all' || tab === 'news')) ? h('div', { class: 'mutedline' },
        h('span', null, [...muted].map(k => NEWS_SOURCES[k] || k).join(', '), ' muted'),
        hiddenBySource ? h('span', { class: 'mono dim' }, ` \u00b7 ${hiddenBySource} hidden`) : null,
        h('span', { class: 'un', onclick: () => { mutedSources().clear(); try { localStorage.removeItem('badgerMutedSources'); } catch (e) {} render(); } }, 'unmute')) : null;
    const seg = (tab === 'news' || tab === 'inj') ? h('div', { class: 'seg' },
        ...[['mine', 'My news'], ['rostered', 'Rostered'], ['avail', 'Available'], ['all', 'All']].map(([k, tt]) => h('span', { class: k === scope ? 'on' : '', onclick: () => { S.ui.newsScope = k; render(); } }, tt)),
        S.newsBusy ? h('span', { class: 'spin', style: 'margin-left:8px' }) : null) : null;
    return h('div', { class: 'card hside' },
        h('div', { class: 'card-h' }, h('div', { class: 'tabs' }, ...[['all', 'All'], ['news', 'News'], ['inj', 'Injuries'], ['txns', 'Transactions'], ['other', 'Other']].map(([k, tt]) => h('span', { class: k === tab ? 'on' : '', onclick: () => { S.ui.pulseTab = k; render(); } }, tt))),
            tab === 'txns' ? h('span', { class: 'lnk', onclick: () => { S.ui.pulseSeason = !S.ui.pulseSeason; if (S.ui.pulseSeason) { const jobs = []; for (let i = 1; i <= S.curWeek; i++) jobs.push(loadTxns(i)); Promise.all(jobs).then(render); } render(); } }, S.ui.pulseSeason ? 'this week ←' : 'season →') : null),
        seg, mutedLine, tab === 'inj' ? injuryFeed(scope) : feed);
}
function myMatchup(week) {
    const ms = S.matchups[week] || []; const my = S.myRoster; if (!my) return null;
    const mine = ms.find(m => m.roster_id === my.roster_id); if (!mine) return null;
    const opp = ms.find(m => m.matchup_id === mine.matchup_id && m.roster_id !== my.roster_id);
    return { mine, opp: opp || null };
}
// ── Sleeper's win probability ────────────────────────────────────────────────
// The number beside their bar is not each side's share of the points — that is
// what we used to show, and it reads 52.4% where they say 59%, because a ratio
// of two totals is not a probability. Theirs is a real claim: the chance the
// margin ends positive.
//
// It is not served. Every response the matchup page receives was captured and
// none of them carries it, so they compute it in their own JS. This is
// therefore a fit, not their source — but p = Phi(margin / 47) reproduces all
// six week-1 matchups exactly as displayed (59/41, 55/45, 51/49, 49/51, 45/55),
// and the three margins large enough to constrain it pin sigma to 46.4-47.3.
// A margin sigma of 47 implies a per-team weekly sigma of about 33 points.
//
// Caveat worth keeping: every one of those matchups was pure projection with
// nothing yet played, so 47 is fitted at maximum uncertainty. If their sigma
// tightens as players lock, ours will drift from theirs during a live week and
// this constant needs re-fitting against a Sunday.
// Sigma is not a constant. Fitting one against six matchups gives an *empty*
// window — no single value satisfies them all — because Sleeper's spread grows
// with the size of the matchup: a 240 point week is less certain at the same
// margin than a 210 point week. Sigma = k * sqrt(total projected points) fits
// all six exactly, k in 3.194-3.234.
//
// And that composes with the other half of the problem. If the uncertainty
// belongs to the football that has not been played, then the quantity under
// the root is not the week's total but what is *left* of it. At kickoff those
// are the same number and this reproduces Sleeper's published percentages to
// the digit; by the final whistle it is zero and the bar resolves to a result,
// where a fixed sigma would still have been calling a decided game a coin flip.
// The model is FBCalc.winProbSig in fb-calc.js, loaded by the manifest ahead of
// this file: one formula for the live odds, the season simulation and the
// replay of a finished game. Nothing in this file is allowed to re-implement it.
if (typeof FBCalc === 'undefined' || typeof FBCalc.winProbSig !== 'function') throw new Error(TAG + ' fb-calc.js did not load ahead of league.js (manifest content_scripts order) — no win-prob model');
let WP = FBCalc.WINPROB_DEFAULTS;
let WP_K = WP.k;   // read by the season sim and the ledger — kept in step with WP
function winProbSig(margin, sigma) { return FBCalc.winProbSig(margin, sigma, WP); }
function winProbFor(A, a, B, b) {
    const left = muUnplayed(A, a) + muUnplayed(B, b);
    return winProbSig(muProjected(A, a) - muProjected(B, b), WP_K * Math.sqrt(Math.max(0, left)));
}

// ── how far through his game each starter is ────────────────────────────────
// One bar per slot, in lineup order, filling as his sixty minutes run. The slot
// letter underneath takes the position's colour and fades once he is done, so
// the row says not just how many are left but which — "a running back and both
// flexes" — without counting along it.
const SLOT_LETTER = { QB: 'Q', RB: 'R', WR: 'W', TE: 'T', K: 'K', DEF: 'D', FLEX: 'F', SUPER_FLEX: 'S', REC_FLEX: 'F', WRRB_FLEX: 'F', IDP_FLEX: 'F' };
function playedStrip(R, m, right) {
    if (!R) return null;
    const slots = starterSlots(), starters = muStarters(R, m);
    const cells = slots.map((sl, i) => {
        const pid = starters[i];
        const empty = !pid || pid === '0';
        const left = empty ? 1 : gameFracLeft(pid);
        const pct = Math.round((1 - left) * 100);
        const pos = empty ? sl : ppos(pid);
        const letter = SLOT_LETTER[sl] || String(sl).charAt(0);
        const state = empty ? 'empty slot' : pct >= 100 ? 'final' : pct <= 0 ? 'not started' : `${pct}% played`;
        return h('div', { class: 'punit', title: empty ? `${sl} — empty slot, scores nothing` : `${pname(pid)} (${pos}) — ${state}` },
            h('i', { class: `pbar${empty ? ' gone' : ''}` }, empty ? null : h('em', { class: right ? 'b' : 'a', style: `height:${pct}%` })),
            h('div', { class: `plet ${empty ? 'gone' : pos}${pct >= 100 ? ' done' : ''}` }, letter));
    });
    // Both strips read in lineup order, QB first. Only the alignment mirrors —
    // reversing the right-hand side made the two teams' pucks impossible to
    // compare slot for slot, which is the one thing the strip is for.
    return h('div', { class: `prow${right ? ' r' : ''}` }, ...cells);
}
// Starters whose game has not finished — the number that actually matters.
function toPlay(R, m) {
    if (!R) return 0;
    return muStarters(R, m).filter(pid => pid && pid !== '0' && gameFracLeft(pid) > 0).length;
}
// ── the week, play by play ───────────────────────────────────────────────────
// Sleeper's `plays` feed carries every snap of a week with a millisecond
// timestamp and the per-player stat deltas it produced. Replaying it through
// this league's scoring settings rebuilds both sides' totals exactly — verified
// against a finished championship, where all sixteen offensive and kicking
// starters came back to the cent — and, because each play has a time, it gives
// the win probability a history instead of a single point.
//
// About 3MB a week, so it is fetched once and cached; a finished week never
// changes and is kept indefinitely, a live one is re-pulled on the socket's
// nudge like everything else.
const PLAYS_TTL = 30e3;
// Two plays can carry the same millisecond — three pairs of them in week 1 —
// and time alone then puts six of the week's plays out of the order they were
// run in. Sleeper's own feed orders by a per-game sequence number; use it as
// the tiebreak, which is the only place it means anything (it restarts per game).
function byPlayOrder(x, y) {
    if (x.time !== y.time) return x.time - y.time;
    if (x.game_id !== y.game_id) return 0;
    const sx = (x.metadata || {}).sequence, sy = (y.metadata || {}).sequence;
    return (typeof sx === 'number' ? sx : 0) - (typeof sy === 'number' ? sy : 0);
}   // Sleeper's play feed already trails its stats; do not add a minute and a half of our own
// One request per week at a time: Home starts it in the background, and a click
// on Scoreboard while it is in flight must join it, not fire a second 3 MB pull.
const playsBusy = {};
function loadPlays(week) {
    if (playsBusy[week]) return playsBusy[week];
    return (playsBusy[week] = loadPlaysNow(week).finally(() => { delete playsBusy[week]; }));
}
async function loadPlaysNow(week) {
    const key = `plays:${S.season}:${week}`;
    const cur = S.plays[week];
    if (cur && (cur.done || Date.now() - cur.at < PLAYS_TTL)) return;
    // A week cached before plays were ordered by sequence keeps the order it was
    // stored in — and a finished week is never refetched — so sort it on the way
    // out of the cache. Three thousand plays sort in a millisecond.
    if (!cur) { const c = await idbGet(key); if (c && c.list) { c.list.sort(byPlayOrder); S.plays[week] = c; if (c.done) return; } }
    try {
        const d = await gql('plays', `query plays { plays(sport: "nfl", season: "${S.season}", season_type: "regular", week: ${week}){ play_id time game_id metadata play_stats { player_id stats } } }`);
        const list = (d.plays || []).slice().sort(byPlayOrder);
        // A week is finished when every game we know about is over; only then is
        // the cache permanent. [].every() is TRUE, so an unloaded kickoff map
        // used to mark a live week done and freeze whatever partial list of
        // plays we happened to hold — in IndexedDB, past the TTL, forever.
        const kicks = S.kickWeek === week ? Object.values(S.kick || {}) : [];
        const done = week < S.curWeek || (list.length > 0 && kicks.length > 0 && kicks.every(k => k.over || k.q === 'F'));
        const rec = { at: Date.now(), done, list };
        S.plays[week] = rec;
        idbSet(key, rec);
    } catch (e) { console.warn(TAG, 'plays:', e.message); S.plays[week] = S.plays[week] || { at: Date.now(), done: false, list: [] }; }
}
// A play's stats as they should be priced. When a completion is challenged and
// overturned, Sleeper rewrites the description and the play type but leaves the
// catch and its yards on the stat lines — a 33-yard "incomplete" worth 1.32.
// The feed's own verdict wins: on an overturned incomplete the catch comes off,
// the target and the attempt stay.
// Two-point conversions come through the feed as attempts — conv_pass_att,
// conv_rec_att, conv_rush_att, with conv_cmp when they succeed — never as the
// box score's pass_2pt / rec_2pt / rush_2pt that leagues score. So a good try
// was priced at nothing: Waddle's two-point catch at 7:44 of the third was worth
// 2.00, and the play log ended the week two points short of Sleeper's final.
// Checked against Sleeper's box scores for every conversion in 2026 weeks 1–3.
const CONV_TO_2PT = { conv_pass_att: 'pass_2pt', conv_rec_att: 'rec_2pt', conv_rush_att: 'rush_2pt' };
function withConversion(ps) {
    const st = ps.stats || {}; if (!st.conv_cmp) return ps;
    const out = Object.assign({}, st);
    for (const k in CONV_TO_2PT) if (st[k] && st[CONV_TO_2PT[k]] == null) out[CONV_TO_2PT[k]] = st[k];
    return { player_id: ps.player_id, stats: out };
}
function playStatsOf(p) {
    const md = p.metadata || {}, list = (p.play_stats || []).map(withConversion);
    if (md.review_result !== 'overturned' || md.play_type !== 'pass_incomplete') return list;
    return list.map(ps => { const st = ps.stats || {}; if (!(st.pass_cmp || st.rec)) return ps;
        const out = {}; for (const k in st) if (!/^(pass_cmp|pass_yd|pass_fd|pass_td|pass_2pt|rec|rec_yd|rec_yar|rec_fd|rec_td|rec_2pt|rec_\d+_\d+|rec_air_yd|rush_)/.test(k)) out[k] = st[k];
        if (st.pass_att) out.pass_inc = (out.pass_inc || 0) + 1;
        return { player_id: ps.player_id, stats: out }; });
}
// An individual defender's stat credits his team's defence, and his team is
// whichever one does not have the ball. Sacks come off the sacked quarterback's
// row, which is authoritative where the tacklers' rows split shared credit.
const IDP_TO_TEAM = { idp_sack: 'sack', idp_int: 'int', idp_ff: 'ff', idp_fum_rec: 'fum_rec', idp_tkl_loss: 'tkl_loss',
    idp_blk_kick: 'blk_kick', idp_safe: 'safe', idp_def_td: 'def_td', idp_int_td: 'def_td', idp_fum_rec_td: 'def_td' };
// What a play gave each defence, from its players' rows: [team, stat, count]. A credit goes to the side without the
// ball, except where the feed books it on someone else's row:
// - A forced fumble (idp_ff) is on the man who FUMBLED, never on the man who forced it (all 42 of 2026 week 5's).
//   It belongs to the other side from the fumbler's own team, under the stat Sleeper's line books it as: ff when
//   his team had the ball at the snap; def_st_ff when he was returning a kick; ff_misc when he was a defender
//   running back a takeaway. "The side without the ball" handed Turpin's kickoff fumble, forced by Tampa Bay, to
//   the Dallas D/ST: a point Sleeper never gave (week 5).
// - A blocked kick is on the kicker's row only (xp_blkd, fg_blkd): blk_kick for the other side, unless the
//   blocker has a row of his own. A return touchdown is on the returner's (st_td): def_st_td for his team.
// A stat the defence's own team row already carries on the play is never added twice.
function defCredits(rows, md) {
    const offense = md.possession, other = offense && md.team && md.opponent ? (offense === md.team ? md.opponent : md.team) : null, out = [], has = new Set();
    const ind = rows.filter(r => /^\d+$/.test(String(r.player_id)));
    for (const r of rows) if (!ind.includes(r)) for (const k in r.stats || {}) has.add(`${r.player_id}:${k}`);
    const blocker = ind.some(r => (r.stats || {}).idp_blk_kick);
    for (const r of ind) {
        const st = r.stats || {}, t = (P(String(r.player_id)) || {}).team, own = t && (t === md.team || t === md.opponent) ? t : null, vs = own ? (own === md.team ? md.opponent : md.team) : other;
        if (st.pass_sack) out.push([other, 'sack', st.pass_sack]);
        for (const k in st) {
            const v = st[k]; if (typeof v !== 'number') continue;
            if (/^(xp|fg|punt)_blkd$/.test(k)) { if (!blocker) out.push([vs, 'blk_kick', v]); continue; }
            if (k === 'st_td') { out.push([own || other, 'def_st_td', v]); continue; }
            const kk = IDP_TO_TEAM[k]; if (!kk || kk === 'sack') continue;
            if (k !== 'idp_ff' || !st.fum || !own || !offense) { out.push([other, kk, v]); continue; }
            out.push([vs, own === offense ? 'ff' : /^(kickoff|punt)/.test(md.play_type || '') ? 'def_st_ff' : 'ff_misc', v]);
        }
    }
    return out.filter(c => c[0] && !has.has(`${c[0]}:${c[1]}`));
}
// Points and yards allowed are end-state brackets and passes defensed never
// appear in the feed at all, so those three ride along from the week's official
// line rather than being rebuilt: flat across the game, right at the whistle.
function defSettled(pid) {
    const st = ((S.stats[S.week] || {})[pid] || {}).stats || {};
    const out = {};
    for (const k in st) if (/^(pts_allow|yds_allow)_/.test(k) || k === 'def_pass_def') out[k] = st[k];
    return out;
}
// Replay the week and keep, for every play that touched a starter, what it was
// worth and what it did to the odds.
function buildLedger(A, a, B, b) {
    const rec = S.plays[S.week];
    if (!rec || !rec.list || !rec.list.length || !A) return null;
    // What the replay reads beyond the plays is part of what it IS: a ledger built
    // before the week's box scores (a defence's points-allowed tiers) or its
    // kickoff map arrived is a different, wrong ledger, and must not be served
    // from the cache once they land.
    const key = [S.week, A.roster_id, B ? B.roster_id : 0, rec.list.length, rec.at, S.stats[S.week] ? 's' : '-', S.kickWeek === S.week ? 'k' : '-'].join(':');
    // Two caches on purpose. S.ledger[S.week] is "the matchup on screen" and the
    // hero, the curve and the points lens all read it directly. S.ledgerAll is
    // keyed, so the all-six scan can price six games without any of them
    // becoming the one those three readers think they are looking at.
    if (!S.ledgerAll) S.ledgerAll = {};        // a vault's state object is built fresh, without one
    // A cache hit still has to BECOME the matchup on screen. Three readers —
    // the window strip, the curve and the points lens — take S.ledger[S.week]
    // directly rather than a return value, so returning early without setting
    // it left the deep dive drawing the last matchup's curve under this one's
    // header. ledgerFor puts both back for the six-way scan.
    if (S.ledgerAll[key]) { const hit = S.ledgerAll[key]; S.ledger[S.week] = hit; S.wpHist[S.week] = hit.hist; return hit; }
    if (S.ledger[S.week] && S.ledger[S.week].key === key) return S.ledger[S.week];

    const sides = new Map();          // pid -> 'a' | 'b'
    for (const pid of muStarters(A, a)) if (pid && pid !== '0') sides.set(pid, 'a');
    if (B) for (const pid of muStarters(B, b)) if (pid && pid !== '0') sides.set(pid, 'b');
    const acc = {};                    // pid -> accumulated raw stats
    const clock = {};                  // game_id -> fraction of the game still to run
    const gameOfTeam = {};             // team -> game_id, learned from the plays
    const feedGames = new Set(rec.list.map(p => p.game_id));   // games the feed has ANY play for
    // Teams the feed has any play for. A player whose team is here has a game in
    // this week's story, so until its first play he is entirely ahead — this needs
    // no kickoff map, which may be loading or belong to another week.
    const feedTeams = new Set();
    for (const p of rec.list) { const md = p.metadata || {}; if (md.team) feedTeams.add(md.team); if (md.opponent) feedTeams.add(md.opponent); }
    for (const pid of sides.keys()) acc[pid] = {};

    const ptsOf = (pid) => {
        const raw = Object.assign({}, acc[pid]);
        if (ppos(pid) === 'DEF') Object.assign(raw, defSettled(pid));
        return scoreStats(raw) || 0;
    };
    const teamOf = (pid) => (P(pid) || {}).team || pid;
    const fracLeft = (pid) => {
        const g = gameOfTeam[teamOf(pid)];
        // No plays yet AT THIS POINT OF THE REPLAY means his game hasn't
        // kicked off yet in the story being retold — in the vault that must
        // read as fully remaining (1), NOT as the week-is-over 0 the fracDone
        // flag gives the display helpers. Sunday's odds must feel Monday's
        // starters coming; the week ended 114.9\u2013114.4 because they did.
        // ...but a game the feed does carry, whose first play is still ahead in the
        // replay, is fully remaining AT THIS INSTANT: reading today's clock for it
        // stamped every Wednesday sample with Sunday's consumed football, and the
        // whole early curve piled up at the frontier.
        if (g == null) {
            if (S.fracDone) return 1;
            if (feedTeams.has(teamOf(pid))) return 1;
            const kg = (insKickInfo(pid) || {}).gid;
            return kg && feedGames.has(kg) ? 1 : gameFracLeft(pid);
        }
        // At or past a game's final play, a game that is TRULY over (today's
        // kickoff data, or the vault) has nothing left — 4th-and-done beats
        // the clock's arithmetic. A game still live never takes this branch.
        if (curT >= (gameEnd[g] || Infinity) && gameFracLeft(pid) === 0) return 0;
        return clock[g] == null ? 1 : clock[g];
    };
    const totalFor = (list) => list.reduce((t, pid) => {
        if (!pid || pid === '0') return t;
        const left = fracLeft(pid);
        return t + (left < 1 ? ptsOf(pid) : 0) + (projOf(pid, S.week) || 0) * left;
    }, 0);
    const scoreFor = (list) => list.reduce((t, pid) => t + (pid && pid !== '0' ? ptsOf(pid) : 0), 0);   // banked points only — no projection
    const stA = muStarters(A, a), stB = B ? muStarters(B, b) : [];
    const leftAll = () => stA.concat(stB).reduce((t, pid) => t + (pid && pid !== '0' ? (projOf(pid, S.week) || 0) * fracLeft(pid) : 0), 0);
    const totAll = stA.concat(stB).reduce((t, pid) => t + (pid && pid !== '0' ? (projOf(pid, S.week) || 0) : 0), 0);
    const consumed = () => totAll > 0 ? Math.min(1, Math.max(0, 1 - leftAll() / totAll)) : 1;   // share of the week's projected football played at this instant
    const odds = () => winProbSig(totalFor(stA) - totalFor(stB), WP_K * Math.sqrt(Math.max(0, leftAll())));

    const hist = [], phist = [], xhist = [], events = [], gameStart = {};   // phist: both banked scores, xhist: football consumed — sampled at hist's instants — the POINTS lens shares the curve's x-axis
    // Each game's LAST play, known up front: the feed's clock stops around
    // 0:14 and never reads 0:00, so without this a finished game keeps a
    // sliver of variance forever — and a half-point lead over one phantom
    // Nacua-minute prices at 78% when the season is already decided.
    const gameEnd = {}; for (const p2 of rec.list) if (p2.game_id != null) gameEnd[p2.game_id] = p2.time;
    let prev = null, lastAt = 0, curT = 0;
    for (const p of rec.list) {
        const md = p.metadata || {}, g = p.game_id;
        curT = p.time;
        if (md.team && md.opponent) { gameOfTeam[md.team] = g; gameOfTeam[md.opponent] = g; }
        const qn = quarterNum(md.quarter_name);
        if (qn) {
            const mins = Number(md.time_remaining_minutes), secs = Number(md.time_remaining_seconds) || 0;
            const rem = qn > 4 ? 0 : (4 - qn) * 15 + (isFinite(mins) ? mins + secs / 60 : 15);
            clock[g] = Math.max(0, Math.min(1, rem / 60));
        }
        // Odds as they stand with the clock already advanced but before this play's
        // stats land, so a row's Win% is what the play itself did. Time passing is
        // real movement too, but it is the curve's business, not the play's — and
        // without this an interception that scored nothing gets blamed for the
        // sixteen points of drift that the previous three minutes caused.
        const wPre = odds();
        const touched = new Set(), before = {};
        const rows = playStatsOf(p);
        for (const ps of rows) {   // a started player's row, a started D/ST's own team row among them
            const pid = ps.player_id, st = ps.stats || {};
            if (!sides.has(pid)) continue;
            if (!(pid in before)) before[pid] = ptsOf(pid); touched.add(pid);
            for (const k in st) if (typeof st[k] === 'number') acc[pid][k] = (acc[pid][k] || 0) + st[k];
        }
        for (const [dTeam, k, v] of defCredits(rows, md)) {   // and what the players' rows gave a started defence
            if (!sides.has(dTeam)) continue;
            if (!(dTeam in before)) before[dTeam] = ptsOf(dTeam);
            touched.add(dTeam);
            acc[dTeam][k] = (acc[dTeam][k] || 0) + v;
        }
        if (p.game_id != null && gameStart[p.game_id] == null) gameStart[p.game_id] = p.time;
        const w = odds();
        if (p.time - lastAt > 20000) { hist.push(w); phist.push([scoreFor(stA), scoreFor(stB)]); xhist.push(consumed()); lastAt = p.time; }
        if (touched.size && prev != null) {
            let dp = 0; for (const pid of touched) dp += ptsOf(pid) - before[pid];
            const dw = w - wPre;
            const sweat = /incomplete/i.test(md.description || '');
            // the most football any starter still had to play after this, and in which game
            let open = 0, openG = null;
            for (const pid of stA.concat(stB)) { if (!pid || pid === '0') continue; const f = fracLeft(pid); if (f > open) { open = f; openG = gameOfTeam[teamOf(pid)] ?? null; } }
            if (Math.abs(dw) >= 0.002 || Math.abs(dp) >= 0.05 || sweat) events.push({
                t: p.time, x: consumed(), w, dw, dp, g: p.game_id, open, openG, ta: totalFor(stA), tb: totalFor(stB), sa: scoreFor(stA), sb: scoreFor(stB),
                who: [...touched].map(pid => ({ pid, side: sides.get(pid), dp: ptsOf(pid) - before[pid], tot: ptsOf(pid), st: Object.assign({}, acc[pid]) })),
                side: [...touched].some(pid => sides.get(pid) === 'a') ? 'a' : 'b',
                desc: (md.fantasy_description || md.description || '').slice(0, 220),
                q: md.quarter_name, clk: `${md.time_remaining_minutes != null ? md.time_remaining_minutes : ''}:${String(md.time_remaining_seconds || 0).padStart(2, '0')}`,
            });
        }
        prev = w;
    }
    if (prev != null) { hist.push(prev); phist.push([scoreFor(stA), scoreFor(stB)]); xhist.push(consumed()); }
    // Once every starter's game is over, the odds jump to the result. Who gets
    // that jump depends on how much football was left after the last logged
    // play. Two minutes or less, and the rest was ceremony (kneel-downs touch no
    // starter, so they never log): a 4th-down stop that ends the matchup IS the
    // play that sealed it, and the 78% the clock's phantom minute priced was
    // not football. More than that, and the clock settled it, not the play: a
    // Waddle run at 3:57 of the third that brought the trailing team closer read as +39
    // for the other side, because the quarter and a half after it, in which he
    // never touched the ball again, was booked to his row. The clock gets its
    // own row.
    const settled = stA.concat(stB).every(pid => !pid || pid === '0' || fracLeft(pid) === 0);
    // Sleeper's final, against what these plays add up to. A replay that comes up
    // short missed some scoring, and then the log must not say nobody scored.
    const truthA = (a && a.points) || 0, truthB = (b && b.points) || 0, known = !!(truthA || truthB);
    const off = known ? Math.max(Math.abs(totalFor(stA) - truthA), Math.abs(totalFor(stB) - truthB)) : 0;
    if (events.length && settled) {
        const last = events[events.length - 1];
        const fin = totalFor(stA) - totalFor(stB);
        const wEnd = fin > 0.005 ? 0.999 : fin < -0.005 ? 0.001 : 0.5;
        if (last.open <= 2 / 60) { last.dw += wEnd - last.w; last.w = wEnd; }
        else if (Math.abs(wEnd - last.w) >= 0.0005) events.push({
            kind: 'clock', t: (last.openG != null && gameEnd[last.openG]) || rec.list[rec.list.length - 1].time, x: consumed(), g: last.openG ?? last.g,
            w: wEnd, dw: wEnd - last.w, dp: 0, mins: Math.round(last.open * 60), sure: off < 0.25, ta: totalFor(stA), tb: totalFor(stB), sa: scoreFor(stA), sb: scoreFor(stB), who: [], side: 'clock', desc: '',
        });
    }
    // The replay should land on the same totals Sleeper reports. It is exact on
    // offence and kickers; a defence can drift by a fraction where the feed
    // omits a stat. Anything larger than a point means the reconstruction has
    // gone wrong and the log below it should not be trusted.
    const finals = { a: totalFor(stA), b: totalFor(stB) };
    const truth = { a: (a && a.points) || 0, b: (b && b.points) || 0 };
    if (truth.a || truth.b) {
        const drift = Math.max(Math.abs(finals.a - truth.a), Math.abs(finals.b - truth.b));
        if (drift > 1 && !stA.concat(stB).some(pid => pid && pid !== '0' && gameFracLeft(pid) > 0)) {
            console.warn(TAG, `ledger drift ${drift.toFixed(2)} — ours ${finals.a.toFixed(2)}/${finals.b.toFixed(2)} vs ${truth.a.toFixed(2)}/${truth.b.toFixed(2)}`);
        }
    }
    if (typeof globalThis !== 'undefined' && globalThis.__LEDGER_DEBUG) { globalThis.__pts = ptsOf; globalThis.__acc = (pid) => acc[pid]; }   // the Node unit check reads the accumulator through these
    const out = { key, hist, phist, xhist, events: events.reverse(), finals, settled, gameStart, gameTeams: gameOfTeam,
        gap: settled && known && off >= 0.25 ? { a: truthA, b: truthB } : null };
    S.ledger[S.week] = out;
    if (Object.keys(S.ledgerAll).length > 24) S.ledgerAll = {};   // keys carry the week and the fetch time, so stale ones simply never match
    S.ledgerAll[key] = out;
    S.wpHist[S.week] = hist;

    return out;
}

// ── the play log ─────────────────────────────────────────────────────────────
// Everything that moved a starter, including the plays that scored nothing: an
// incompletion still drains a projection, and the odds still move. Points and
// win probability are separate columns because they are separate facts.
const BIG_WP = 0.05, BIG_PTS = 6;   // the \u2605 filter: a twentieth of the game, or a TD-sized haul
// A Sleeper play description, condensed to the phrase that matters. The full
// sentence always rides the row's title attribute.
function playPhrase(desc) {
    const d = desc || ''; let m;
    const yd = (n) => `${n} yd${Math.abs(Number(n)) === 1 ? '' : 's'}`;
    // before anything else: a conversion's description also says "Catch made by" and "rushed"
    // (the full play reads "TWO-POINT CONVERSION ATTEMPT … SUCCEEDS / FAILS"; the fantasy line
    // Sleeper writes for a good one reads "Bo Nix 2-PT pass complete to Jaylen Waddle")
    if (/TWO-POINT|2-PT/i.test(d)) {
        if (/FAILS/i.test(d) || (/TWO-POINT/i.test(d) && !/SUCCEEDS/i.test(d))) return '2-pt try failed';
        return /Catch made|pass complete/i.test(d) ? 'catch, 2-pt good' : /rush|runs?\b|scrambl/i.test(d) ? 'run, 2-pt good' : '2-pt good';
    }
    if ((m = d.match(/TOUCHDOWN.*?(\d+)\s*Yd\s*(pass|run|rush)/i))) return m[2].toLowerCase() === 'pass' ? `TD catch, ${yd(m[1])}` : `TD run, ${yd(m[1])}`;
    if (/TOUCHDOWN/i.test(d)) return 'TOUCHDOWN';
    if ((m = d.match(/incomplete.*?intended for\s+[A-Z]['.A-Za-z-]+\s*\(([A-Z]['.A-Za-z-]+)\)/i))) return `target \u2014 broken up (${m[1]})`;
    if (/incomplete/i.test(d)) return /intended for/i.test(d) ? 'target, incomplete' : 'pass, incomplete';
    if ((m = d.match(/(\d+)\s*Yd pass complete/i))) return `catch, ${yd(m[1])}`;
    if ((m = d.match(/Catch made by .*? for (\d+)/i))) return `catch, ${yd(m[1])}`;
    if ((m = d.match(/pass complete.*?for (\d+) yard/i))) return `catch, ${yd(m[1])}`;
    if ((m = d.match(/(-?\d+)\s*Yd\s*(?:run|rush)/i))) return `run, ${yd(m[1])}`;
    if ((m = d.match(/(-?\d+)\s*Yd\s*(?:reception|catch)/i))) return `catch, ${yd(m[1])}`;
    if (/extra point is good/i.test(d)) return 'XP good';
    if (/extra point/i.test(d)) return 'XP missed';
    if ((m = d.match(/(\d+)\s*Yd field goal/i))) return /good/i.test(d) ? `FG good, ${yd(m[1])}` : `FG miss, ${yd(m[1])}`;
    if ((m = d.match(/sacked.*?for (-?\d+)/i))) return `sacked, ${m[1]}`;
    if ((m = d.match(/punts (\d+) yards/i))) return `punt, ${yd(m[1])}`;
    if ((m = d.match(/intercept/i))) return 'INTERCEPTED';
    if (/fumble/i.test(d)) return 'fumble';
    if ((m = d.match(/(?:runs?|rush(?:es)?|scrambles).*?for (-?\d+) yard/i))) return `run, ${yd(m[1])}`;
    if ((m = d.match(/for (-?\d+) yards?/i))) return `${yd(m[1])}`;
    return d.slice(0, 46) || '\u2014';
}
// Sleeper numbers a play's quarter "1" to "4" and calls overtime "OT". Read as a
// bare number, overtime was no quarter at all: its plays lost their clock in the
// log, the game's clock stopped where the fourth quarter left it, and the game
// view labelled them "QOT".
const quarterNum = (name) => { const q = String(name == null ? '' : name); return /ot/i.test(q) ? 5 : Number(q.replace(/[^0-9]/g, '')) || 0; };
const playQuarter = (name) => { const n = quarterNum(name); return !n ? '' : n > 4 ? 'OT' : `Q${n}`; };
const SLOT_FMT = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }); } catch (e) { return null; } })();
function gameSlot(ms) {
    let day, hour;
    if (SLOT_FMT) { const p = {}; for (const x of SLOT_FMT.formatToParts(ms)) p[x.type] = x.value; day = p.weekday; hour = Number(p.hour) % 24; }
    else { const d = new Date(ms); day = DAY[d.getDay()]; hour = d.getHours(); }
    // an NFL week runs Wednesday to Tuesday: a Wednesday game OPENS the week
    // (2026's Yom Kippur opener), a Tuesday game is a postponement closing it
    if (day === 'Wed') return { r: 0, n: 'WEDNESDAY' };
    if (day === 'Thu') return { r: 1, n: 'THURSDAY NIGHT' };
    if (day === 'Fri') return { r: 2, n: 'FRIDAY NIGHT' };
    if (day === 'Sat') return { r: 3, n: hour >= 19 ? 'SATURDAY NIGHT' : 'SATURDAY' };
    if (day === 'Sun') {
        if (hour < 11) return { r: 4, n: 'SUNDAY MORNING \u00b7 LONDON' };
        if (hour < 15) return { r: 5, n: 'SUNDAY \u00b7 EARLY WINDOW' };
        if (hour < 19) return { r: 6, n: 'SUNDAY \u00b7 LATE WINDOW' };
        return { r: 7, n: 'SUNDAY NIGHT' };
    }
    if (day === 'Mon') return { r: 8, n: 'MONDAY NIGHT' };
    return { r: 9, n: day.toUpperCase() };
}
// The log: loud team
// columns (score \u00b7 odds per team, the touched cell lit), the player's full
// name leading each row in his team's colour, the play as a phrase — and under
// the two team columns one shared track whose boundary slides with the game.
// Price one matchup WITHOUT becoming the matchup on screen. buildLedger writes
// three globals that the hero, the curve and the points lens read as "the game
// you are looking at" — all three go back exactly as they were. The relay is
// suppressed too: handing the server five games the user is not in is not what
// the privacy note describes, and the focused matchup relays on its own.
function ledgerFor(A, a, B, b) {
    const keepL = S.ledger[S.week], keepH = S.wpHist[S.week];
    S.ledgerQuiet = true;
    try { return buildLedger(A, a, B, b); }
    finally { S.ledgerQuiet = false; S.ledger[S.week] = keepL; S.wpHist[S.week] = keepH; }
}
function playLog(A, a, B, b) {
    const ui = S.ui;
    if (ui.logSide == null) ui.logSide = 'all';
    const L = buildLedger(A, a, B, b);
    const rec = S.plays[S.week];
    const nmA = A ? teamName(A) : '\u2014', nmB = B ? teamName(B) : '\u2014';
    // A side's filter and column header carry its avatar and as much of the name
    // as fits, cut with an ellipsis by CSS — slice(0, 12) cut a thirteen-letter name one short.
    const seg = (k, txt, cls) => h('span', { class: `${ui.logSide === k ? 'on' : ''} ${cls || ''}`, title: k === 'all' ? null : (k === 'a' ? nmA : nmB), onclick: () => { ui.logSide = k; render(); } }, txt);
    const sideLab = (R, nm) => [R ? avatarEl(R, 'xs') : null, h('span', { class: 'lnm' }, nm)];
    const head = h('div', { class: 'card-h' }, h('h3', null, 'Play log'),
        h('div', { style: 'margin-left:auto;display:flex;gap:7px;align-items:center' },
            h('div', { class: 'seg lseg' }, seg('all', 'All'), seg('a', sideLab(A, nmA), 'sa'), seg('b', sideLab(B, nmB), 'sb')),
            h('span', { class: `tog${ui.logBig ? ' on' : ''}`, title: `Only plays worth at least ${Math.round(BIG_WP * 100)} points of win probability or ${BIG_PTS} fantasy points`, onclick: () => { ui.logBig = !ui.logBig; render(); } }, '\u2605 Big swings')));
    if (!L) return h('div', { class: 'card plcard' }, head, h('div', { class: 'empty', style: 'flex:1;display:flex;align-items:center;justify-content:center' }, rec ? 'Nothing has been played yet this week.' : `Reading every play of week ${S.week} from Sleeper \u2014 a few seconds the first time, instant after`));
    const all = L.events;
    // Newest first, in the order things happened, and nothing else. The log
    // used to be filed under its game's broadcast window, newest window first:
    // an early game that ran into overtime then sat under plays from the late
    // window that had happened before it. Only the day is marked, where it
    // changes, because a time of day does not say which day.
    const dayOf = (t) => { const d = new Date(t); return { k: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, n: d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase() }; };
    const shown = all.map((e, i) => ({ e, i })).filter(({ e }) => (ui.logSide === 'all' || e.side === ui.logSide) && (!ui.logBig || Math.abs(e.dw) >= BIG_WP || Math.abs(e.dp) >= BIG_PTS))
        .sort((x, y) => (y.e.t - x.e.t) || (y.i - x.i))
        .map(({ e }) => ({ e, slot: dayOf(e.t) }));
    // A table per day with a sticky div label above each — Chrome pins a sticky
    // td to the whole table, not its tbody, so real push-out group headers need
    // to live outside the tables. Identical fixed colgroups keep every day's
    // columns aligned.
    // The side columns hold "152.72 · 99.9%" and the swing under it: at 96px the
    // last digit of the percentage was cut off.
    const mkcols = () => h('colgroup', null, h('col', { style: 'width:60px' }), h('col'), h('col', { style: 'width:108px' }), h('col', { style: 'width:116px' }));
    // The column header rides a sticky DIV, not a sticky th — a th can only
    // stick within its own table, and this pane holds one table per day.
    const wrap = h('div', { class: 'plscroll', 'data-keep': 'plog' },
        h('div', { class: 'lhw' }, h('table', { class: 'plog' }, mkcols(), h('tr', { class: 'lth' }, h('th', null, 'When'), h('th', null, 'Play'),
            h('th', { class: 'r', title: `${nmA} \u2013 ${nmB}, after the play` }, 'Score now'), h('th', { class: 'r', title: 'Win % after the play, and how far it moved' }, 'Win')))));
    let body = null;
    // The win column (N3a): each team's odds stacked around one bar. The stretch
    // this play moved is lit in the colour of the team that GAINED, and the side
    // whose odds fell dims, so the direction reads without a legend.
    const winCell = (e) => {
        const pAr = Math.max(0.1, Math.min(99.9, e.w * 100)), pBr = 100 - pAr;
        const v = e.dw * 100, moved = Math.abs(v) >= 0.05;
        const gainA = moved && v > 0, gainB = moved && v < 0;
        const sw = (x) => h('small', { class: x > 0 ? 'up' : 'dn' }, `${x > 0 ? '▲' : '▼'}${Math.abs(x).toFixed(1)}`);
        const base = gainA ? Math.max(0, pAr - v) : pAr;          // teal runs to where A stood before a gain, or where A stands after a loss
        const lit = moved ? Math.max(1.5, Math.min(Math.abs(v), 100 - base)) : 0;
        return h('span', { class: 'wst2', title: `${nmA} ${pAr.toFixed(1)}% — ${pBr.toFixed(1)}% ${nmB}` },
            h('span', { class: `wl a${gainB ? ' lose' : ''}` }, `${pAr.toFixed(1)}%`, moved ? sw(v) : null),
            h('span', { class: 'bar2' }, h('i', { class: 'a', style: `width:${base}%` }),
                lit ? h('i', { class: gainA ? 'ga' : 'gb', style: `width:${lit}%` }) : null, h('i', { class: 'b' })),
            h('span', { class: `wl b${gainA ? ' lose' : ''}` }, `${pBr.toFixed(1)}%`, moved ? sw(-v) : null));
    };
    // What the scorer has done so far this game, as of this play.
    const cumLine = (w2) => { const a2 = w2 && w2.st ? gameStatAtoms(w2.pid, w2.st) : null; if (!a2) return null; const kids = []; a2.forEach((t, i) => { if (i) kids.push(' · '); kids.push(h('span', { class: 'cat' }, t)); }); return h('div', { class: 'cum mono' }, ...kids); };
    const clockTxt = (e) => { const q = playQuarter(e.q); return q ? `${q} ${e.clk || ''}`.trim() : ''; };
    let lastSlot = null;
    for (const { e, slot } of shown.slice(0, 120)) {
        if (slot.k !== lastSlot) {
            body = h('tbody');
            wrap.append(h('div', { class: 'slotgrp' },
                h('div', { class: 'sloth' }, h('div', { class: 'slotin' }, h('span', { class: 'ln' }), h('span', { class: 'lbl' }, slot.n), h('span', { class: 'ln' }))),
                h('table', { class: 'plog' }, mkcols(), body)));
            lastSlot = slot.k;
        }
        const d = new Date(e.t), hr = d.getHours() % 12 || 12, at = `${hr}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'a' : 'p'}`;
        // the clock's row: every game over, and the jump to the result belongs to no play
        if (e.kind === 'clock') {
            body.append(h('tr', { class: `evt clk${Math.abs(e.dw) >= 0.05 ? ' maj' : ''}` },
                h('td', { class: 'tm' }, h('b', null, at), h('span', null, 'FINAL')),
                h('td', { class: 'lgp' }, h('div', null, h('b', null, 'Time ran out')),
                    h('div', { class: 'phw' }, e.sure ? `${e.mins} more minute${e.mins === 1 ? '' : 's'} passed without a starter scoring` : `${e.mins} more minute${e.mins === 1 ? '' : 's'} to the final whistle`)),
                h('td', { class: 'r mono cell' }, h('div', null, h('span', { class: 'wa' }, fmtS(e.sa)), h('span', { class: 'dim' }, '–'), h('span', { class: 'wb' }, fmtS(e.sb)))),
                h('td', { class: 'r wcell' }, winCell(e))));
            continue;
        }
        let phrase = playPhrase(e.desc);
        if (/^(TD )?catch/.test(phrase) && e.who.length && e.who.every(w2 => ppos(w2.pid) === 'QB')) phrase = phrase.replace('catch', 'completion');
        // AMBER = worth the eye: any scoring play, a big fantasy haul, or a
        // 5-point odds move (per the user — 10 proved too stingy).
        const loud = /^(TD|TOUCHDOWN|FG good|XP good)|2-pt good/.test(phrase) || Math.abs(e.dp) >= 5 || Math.abs(e.dw) >= 0.05;
        const names = e.who.map(x => pname(x.pid)).join(', ');
        const noPts = Math.abs(e.dp) < 0.05;
        const lead = e.who.slice().sort((x, y) => Math.abs(y.dp || 0) - Math.abs(x.dp || 0))[0];
        body.append(h('tr', { class: `evt${loud ? ' maj' : ''}` },
            h('td', { class: 'tm' }, h('b', null, at), h('span', null, clockTxt(e))),
            h('td', { class: 'lgp', title: e.desc },
                e.who.length <= 1
                    ? h('div', null, h('b', { class: `pn ${e.side}` }, names),
                        h('span', { class: `mono lgd ${noPts ? 'zero' : e.dp > 0 ? 'up' : 'dn'}` }, noPts ? '0 pts' : `${e.dp > 0 ? '+' : ''}${fmtS(e.dp)}`))
                    : h('div', { class: 'wstack' }, ...e.who.slice().sort((x, y) => Math.abs(y.dp || 0) - Math.abs(x.dp || 0)).map((w2, i, arr) => {
                        const d2 = w2.dp || 0, z = Math.abs(d2) < 0.05;
                        return h('div', { class: 'wline' },
                            h('span', { class: 'br' }, i === 0 ? '┌' : i === arr.length - 1 ? '└' : '├'),
                            h('b', { class: `pn ${w2.side}` }, pname(w2.pid)),
                            h('span', { class: `mono lgd ${z ? 'zero' : d2 > 0 ? 'up' : 'dn'}` }, z ? '0 pts' : `${d2 > 0 ? '+' : ''}${fmt1(d2)}`));
                    })),
                h('div', { class: loud ? 'phb' : noPts ? 'ph' : 'phw' }, phrase),
                cumLine(lead)),
            h('td', { class: 'r mono cell' },
                e.sa != null ? h('div', null, h('span', { class: 'wa' }, fmtS(e.sa)), h('span', { class: 'dim' }, '–'), h('span', { class: 'wb' }, fmtS(e.sb))) : null,
                e.ta != null ? h('div', { class: 'projsm' }, `proj ${fmt1(e.ta)}–${fmt1(e.tb)}`) : null),
            h('td', { class: 'r wcell' }, winCell(e))));
    }
    const foot = h('div', { class: 'cap' }, shown.length ? `${Math.min(shown.length, 120)} of ${all.length} plays that touched a starter${ui.logBig ? ' \u2014 showing only the big ones' : ''} \u00b7 incompletions score nothing but burn clock \u00b7 between rows, the clock alone moves the odds` : 'Nothing matches that filter yet.');
    // plays that don't add up to Sleeper's final say so, rather than tell a story short of it
    const gap = L.gap ? h('div', { class: 'cap', style: 'color:var(--amber)' }, `These plays add up to ${fmtS(L.finals.a)}–${fmtS(L.finals.b)}; Sleeper’s final is ${fmtS(L.gap.a)}–${fmtS(L.gap.b)}. The difference is scoring the play feed doesn’t show.`) : null;
    return h('div', { class: 'card plcard' }, head, wrap, gap, foot);
}

function matchupHeader(roster, compact) {
    const mm = roster ? (function () { const ms = S.matchups[S.week] || []; const a = ms.find(m => m.roster_id === roster.roster_id); if (!a) return null; return { mine: a, opp: ms.find(m => m.matchup_id === a.matchup_id && m.roster_id !== roster.roster_id) || null }; })() : null;
    if (!mm) return h('div', { class: 'empty' }, S.matchups[S.week] ? 'No matchup this week.' : 'Loading matchup…');
    const A = rosterById(mm.mine.roster_id), B = mm.opp ? rosterById(mm.opp.roster_id) : null;
    const fA = muProjected(A, mm.mine), fB = muProjected(B, mm.opp);
    const aA = mm.mine.points || 0, aB = mm.opp ? mm.opp.points || 0 : 0;
    const leftA = toPlay(A, mm.mine), leftB = toPlay(B, mm.opp);
    const done = leftA === 0 && leftB === 0 && (aA > 0 || aB > 0);
    const started = aA > 0 || aB > 0 || S.week < S.curWeek;
    let wA = Math.round(winProbFor(A, mm.mine, B, mm.opp) * 100);
    if (!done) wA = Math.max(1, Math.min(99, wA));   // never claim certainty while football remains
    // The projection line shows only when it says something the score does not:
    // before kickoff the score IS the projection, and at the end there is
    // nothing left to project.
    const sA = started ? aA : fA, sB = started ? aB : fB;
    const meta = (R, n) => R ? `${record(R)} · ${ordinal(rosterRank().findIndex(r => r.roster_id === R.roster_id) + 1)}${n ? ' · ' + n + ' to play' : ''}` : '';
    const side = (R, m2, n, right, bare) => h('div', { class: `mside${right ? ' r' : ''}` },
        !right ? avatarEl(R) : null,
        h('div', { style: 'min-width:0' }, h('div', { class: 'mtn' }, R ? teamLink(R) : 'Bye'), h('div', { class: 'mtr' }, meta(R, n)), bare ? null : playedStrip(R, m2, right)),
        right ? avatarEl(R) : null);
    const score = h('div', { class: 'mscore' },
        h('div', { class: `mlab${started && !done ? ' live' : ''}` }, done ? 'FINAL' : started ? '● LIVE' : 'PROJECTED'),
        h('div', { class: 'mnum', style: compact ? 'font-size:24px' : '' }, fmtS(sA), h('span', { class: 'd' }, '–'), fmtS(sB)),
        started && !done ? h('div', { class: 'mproj' }, 'proj ', h('b', null, fmtS(fA)), ' – ', h('b', null, fmtS(fB))) : null);
    // Home reuses this at a third of the width, where a curve has nowhere to go
    // — it keeps the bar, which is what the bar is still good for.
    if (compact === 'nobar') return h('div', { class: 'mhero compact' }, h('div', { class: 'mleft' }, side(A, mm.mine, leftA, false), score, side(B, mm.opp, leftB, true)));
    // Once it is over, chance is not the fact — the margin is.
    if (compact && done) {
        const m2 = aA - aB;
        return h('div', { class: 'mhero compact' },
            h('div', { class: 'mleft' }, side(A, mm.mine, leftA, false), score, side(B, mm.opp, leftB, true)),
            h('div', { class: 'mwcap', style: 'text-align:center' }, m2 === 0 ? 'TIED' : `${m2 > 0 ? 'WON' : 'LOST'} BY ${fmtS(Math.abs(m2))}`));
    }
    if (compact) return h('div', { class: 'mhero compact' },
        h('div', { class: 'mleft' }, side(A, mm.mine, leftA, false), score, side(B, mm.opp, leftB, true)),
        h('div', { class: 'mwcap' }, 'CHANCE TO WIN'),
        h('div', { style: 'display:flex;align-items:center;gap:10px' },
            h('span', { class: 'mono', style: 'font-size:12px;font-weight:700;color:var(--teal)', title: 'Chance of winning' }, `${wA}%`),
            h('div', { class: 'bar split', style: 'flex:1;height:8px;margin:0' }, h('i', { style: `width:${wA}%` }), h('i', { style: `width:${100 - wA}%` })),
            h('span', { class: 'mono', style: 'font-size:12px;font-weight:700;color:var(--blue, #5b9cf5)', title: 'Chance of winning' }, `${100 - wA}%`)));
    // A finished matchup keeps its windows: who scored what in the early games,
    // the late ones and the night games is the story of how it was won. Only a
    // week with no kickoff times on record falls back to the bare score.
    const g = muGauge(A, mm.mine, B, mm.opp, { started, done, fA, fB }) || (done ? { rowA: null, rowB: null, rail: h('div', { class: 'mgrail' }, h('div', { class: 'wins' }), h('span', { class: 'mlamp' }, 'FINAL')) } : null);
    const rankOf = (R) => R ? ordinal(rosterRank().findIndex(r => r.roster_id === R.roster_id) + 1) : '';
    const blk = (R, sideK, sVal, lead, gRow) => h('div', { class: `tmblk ${sideK}` },
        h('div', { class: 'tline' },
            h('span', { class: 'tnm' }, R ? teamLink(R) : 'Bye'),
            h('span', { class: 'tmeta' }, R ? `${record(R)} \u00b7 ${rankOf(R)}` : ''),
            h('span', { class: `tscore mono${lead ? '' : ' trail'}` }, fmtS(sVal))),
        gRow);
    // The curve card has two lenses on one axis: WIN % (the default) and
    // POINTS — the two scores climbing, each with its distance from pace.
    // "Pace" is where the score would sit had every played starter hit his
    // projection exactly, so actual − pace is simply projected final − pregame
    // projection: the one number this page never stated before.
    const lens = wpLens(), pts = lens === 'pts', proj = lens === 'proj', pre = preProj;
    const paceEl = (fX, preX) => {
        if (!pts || !started || done) return null;
        const d = fX - preX, sign = d >= 0 ? '+' : '−';
        return h('span', { class: 'pace', title: 'Actual points minus what the played starters were projected for' }, h('b', { class: d >= 0 ? 'up' : 'dn' }, `${sign}${fmt1(Math.abs(d))}`), ' vs pace');
    };
    const lensEl = (ghost) => h('span', { class: `wlens${ghost ? ' ghost' : ''}` },
        h('span', { class: lens === 'wp' ? 'on' : '', onclick: ghost ? null : () => setWpLens('wp') }, 'WIN %'),
        h('span', { class: pts ? 'on' : '', onclick: ghost ? null : () => setWpLens('pts') }, 'POINTS'),
        h('span', { class: proj ? 'on' : '', onclick: ghost ? null : () => setWpLens('proj') }, 'PROJECTED'));
    // the lens switch lives on the card's title row now, with the copy button; the rows are name and number
    const wpRow = (R, cls, num, fX, preX) => h('div', { class: `wprow ${cls}` }, avatarEl(R, 'xs'), h('span', { class: 'nm2' }, R ? teamName(R) : 'Bye'),
        h('span', { class: 'sp' }), paceEl(fX, preX), h('span', { class: 'n' }, num));
    // Before anyone in the matchup kicks off, the odds lead the score card; the curve
    // has nothing to draw yet and the play log nothing to list.
    const fcast = started ? null : h('div', { class: 'mfc' },
        h('b', { class: 'mono' }, `${wA}%`), h('span', { class: 'mfcw' }, 'to win'),
        h('span', { class: 'mono dim mfcp' }, `projected ${fmtS(fA)} \u2013 ${fmtS(fB)}`),
        h('span', { class: 'bar split mfcb' }, h('i', { style: `width:${wA}%` }), h('i', { style: `width:${100 - wA}%` })),
        h('span', { class: 'mono dim' }, `${100 - wA}%`));
    return h('div', { style: 'display:contents' },
        // Both cards carry a title row like every other card: it names what the card shows and
        // holds the copy button, so the content beneath runs the card's full width.
        h('div', { class: 'card mscard' },
            h('div', { class: 'card-h' }, h('h3', null, 'Score by window'), h('span', { class: 'dim', style: 'font-size:12px' }, 'what each window of games has scored')),
            fcast,
            blk(A, 'a', sA, sA >= sB, g && g.rowA),
            blk(B, 'b', sB, sB > sA, g && g.rowB),
            g && g.rail),
        h('div', { class: 'card mwpcard' },
            h('div', { class: 'card-h' }, h('h3', null, pts ? 'Points through the week' : proj ? 'Projected finals' : 'Win probability'), lensEl(false)),
            h('div', { class: 'mwp' },
                wpRow(A, 't', pts ? fmtS(sA) : proj ? fmtS(fA) : `${wA}%`, fA, pre(A, mm.mine)),
                // the second team's row sits right under the curve, above the window names and the strip a hover fills
                // (the user, 2026-10-25: the second team's line goes "above the details of the hover location")
                (() => { const box = wpChart(A, mm.mine, B, mm.opp, pts || proj ? { proj, sA: aA, sB: aB, fA, fB, started, done } : null), sv2 = box.querySelector('svg');
                    if (!box.querySelector('.wfoot')) box.append(h('div', { class: 'wfoot' }));
                    sv2.after(wpRow(B, 'b', pts ? fmtS(sB) : proj ? fmtS(fB) : `${100 - wA}%`, fB, pre(B, mm.opp))); return box; })())));
}
// The lens is a per-viewer preference, kept in localStorage like the UI toggle.
function wpLens() { if (S.ui.wpLens) return S.ui.wpLens; let v = 'wp'; try { const k = localStorage.getItem('badgerWpLens'); v = k === 'pts' || k === 'proj' ? k : 'wp'; } catch (e) {} return (S.ui.wpLens = v); }
function setWpLens(v) { S.ui.wpLens = v; try { localStorage.setItem('badgerWpLens', v); } catch (e) {} render(); }
// The curve. Until the week's play history is wired in there is one point to
// draw — where it stands now — so it renders as a flat line at that value,
// which is the truth before anything has been played.
const WIN_EQ = 0.5;   // share of a window box's growth dealt out equally rather than by projected points
const SLOT_SHORT = { 'WEDNESDAY': 'WED', 'THURSDAY NIGHT': 'THU', 'FRIDAY NIGHT': 'FRI', 'SATURDAY': 'SAT', 'SATURDAY NIGHT': 'SAT N', 'SUNDAY MORNING \u00b7 LONDON': 'SUN AM', 'SUNDAY \u00b7 EARLY WINDOW': 'SUN E', 'SUNDAY \u00b7 LATE WINDOW': 'SUN L', 'SUNDAY NIGHT': 'SNF', 'MONDAY NIGHT': 'MON' };
// The week's broadcast windows for this matchup — every starter bucketed by
// kickoff, each window carrying its projected share — shared by the gauge
// (which sizes its cells by it) and the curve card (which marks them on its
// x-axis, the same share consumed in order).
function muWindows(A, a, B, b) {
    if (A) buildLedger(A, a, B, b);   // memoised; primes gameStart/gameTeams for archived weeks
    const L = S.ledger && S.ledger[S.week];
    const gs = (L && L.gameStart) || {}, gt = (L && L.gameTeams) || {};
    const kickTs = (pid) => {
        const team = (P(pid) || {}).team;
        if (team && gt[team] != null && gs[gt[team]] != null) return gs[gt[team]];
        const k = insKickInfo(pid);
        if (k && k.t) { const t2 = Date.parse(k.t); if (isFinite(t2)) return t2; }
        return null;
    };
    const slots = starterSlots(), ent = [];
    const addSide = (R, m, sideK) => { if (!R) return; const stt = muStarters(R, m);
        slots.forEach((sl, i2) => { const pid = stt[i2];
            if (!pid || pid === '0') { ent.push({ side: sideK, empty: true, letter: SLOT_LETTER[sl] || String(sl)[0], pos: sl }); return; }
            const pos = ppos(pid);
            ent.push({ side: sideK, pid, letter: SLOT_LETTER[pos] || String(pos)[0], pos, proj: projOf(pid, S.week) || 0, pts: (m && m.players_points && m.players_points[pid]) || 0, ts: kickTs(pid), frac: gameFracLeft(pid), name: pname(pid) });
        }); };
    addSide(A, a, 'a'); addSide(B, b, 'b');
    const wins = {};
    for (const e of ent) {
        if (e.empty || e.ts == null) continue;
        const sl = gameSlot(e.ts), k = sl.r + '|' + sl.n;
        const w2 = wins[k] = wins[k] || { rank: sl.r, name: SLOT_SHORT[sl.n] || sl.n.slice(0, 5), minTs: e.ts, proj: 0, a: [], b: [] };
        w2.proj += e.proj; w2.minTs = Math.min(w2.minTs, e.ts); w2[e.side].push(e);
    }
    const unknown = ent.filter(e => !e.empty && e.ts == null);
    if (unknown.length) { const w2 = wins.z = { rank: 98, name: 'TBD', minTs: Infinity, proj: 0, a: [], b: [] }; for (const e of unknown) { w2.proj += e.proj; w2[e.side].push(e); } }
    const list = Object.values(wins).sort((x, y) => x.rank - y.rank || x.minTs - y.minTs);
    if (!list.length) return null;
    const last = list[list.length - 1];
    for (const e of ent.filter(e2 => e2.empty)) last[e.side].push(e);   // an empty slot rides the final window, dashed and judging
    const tot = list.reduce((t2, w2) => t2 + w2.proj, 0) || 1;
    let cum = 0;
    for (const w2 of list) {
        const ps = w2.a.concat(w2.b).filter(e => !e.empty);
        w2.done = ps.length > 0 && ps.every(e => e.frac === 0);
        w2.live = ps.some(e => e.frac > 0 && e.frac < 1);
        w2.pts = { a: w2.a.reduce((t2, e) => t2 + (e.pts || 0), 0), b: w2.b.reduce((t2, e) => t2 + (e.pts || 0), 0) };   // what the window has banked, per side
        w2.share = w2.proj / tot; w2.x0 = cum; cum += w2.share; w2.x1 = cum;   // the window's span of the week's football, 0..1
        // identical flex on both rows and the rail keeps the columns honest:
        // basis fits the fuller side's pucks, growth follows projected points
        // growth is half equal, half by points: a pure share made Monday a sliver
        // and the late window a plain; the pucks' basis still fits every box
        w2.flex = `${((1 - WIN_EQ) * w2.share + WIN_EQ / list.length).toFixed(3)} 0 ${8 + Math.max(w2.a.length, w2.b.length) * 15 + (w2.done || w2.live ? 30 : 0)}px`;
    }
    return list;
}
// Plain window names for the gauge's rail: "SUN E" had to be learned.
const WIN_PLAIN = { WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', 'SAT N': 'Sat night', 'SUN AM': 'Sun morning', 'SUN E': 'Sun early', 'SUN L': 'Sun late', SNF: 'Sun night', MON: 'Mon', TBD: 'TBD' };
function muGauge(A, a, B, b, st2) {
    const list = muWindows(A, a, B, b);
    if (!list) return null;
    // Pucks carry the position in its own colour at a readable size; an empty slot
    // is a dashed red puck. A window's total reads as points.
    const puck = (e) => h('span', { class: `wpk2 ${e.pos}${e.empty ? ' emp' : ''}${!e.empty && e.frac === 0 ? ' done' : ''}`,
        title: e.empty ? `${slotLabel(e.pos)} \u2014 empty slot` : `${e.name} (${e.pos})${e.frac === 0 ? ' \u2014 final' : e.frac < 1 ? ' \u2014 live' : ''}` },
        e.empty ? slotLabel(e.pos) : posLabel(e.pos));
    // A played or live window says what it was worth, at the box's right edge;
    // an upcoming one stays clean — the H2H holds the projections.
    const worth = (w2, sideK) => (w2.done || w2.live) && w2[sideK].some(e => !e.empty)
        ? h('span', { class: 'wsc', title: w2.live ? 'Points so far in this window' : 'Points this window scored' }, w2.live ? h('i', { class: 'wlive' }, '\u25cf ') : null, fmt1(w2.pts[sideK])) : null;   // points, like every number on the card: no unit
    const row = (sideK, fProj) => h('div', { class: 'mgrow' },
        ...list.map(w2 => h('div', { class: `mgseg${w2.done ? ' played' : ''}${w2.live ? ' live' + sideK : ''}`, style: `flex:${w2.flex}` }, ...w2[sideK].map(puck), worth(w2, sideK))),
        h('span', { class: 'mgproj mono' }, st2.started && !st2.done ? ['proj ', h('b', null, fmtS(fProj))] : ''));
    const rail = h('div', { class: 'mgrail' },
        h('div', { class: 'wins' }, ...list.map(w2 => h('span', { class: `wl${w2.live ? ' on' : ''}`, style: `flex:${w2.flex}` }, WIN_PLAIN[w2.name] || w2.name, w2.done ? ' \u2713' : w2.live ? h('i', { class: 'wlive' }, ' \u25cf') : ''))),
        h('span', { class: 'mlamp' }, st2.done ? 'FINAL' : st2.started ? '\u25cf LIVE' : 'PROJECTED'));
    return { rowA: row('a', st2.fA), rowB: row('b', st2.fB), rail };
}
function wpChart(A, a, B, b, ptsOpts) {
    buildLedger(A, a, B, b);   // memoised; the hero renders before the log that would otherwise fill this in
    const W = 360, H = 118, PAD = 6, series = (S.wpHist && S.wpHist[S.week]) || [];
    if (ptsOpts && ptsOpts.proj) return projChart(A, a, B, b, ptsOpts, W, H, PAD);
    if (ptsOpts) return ptsChart(A, a, B, b, ptsOpts, W, H, PAD);
    const w = winProbFor(A, a, B, b);
    // The x-axis is game time: the trace reaches only as far as the matchup
    // has been PLAYED, the dot riding the frontier — far left before kickoff,
    // midway with half the football gone, the full span once it's final.
    const { svg, mk, box, xmap } = chartFrame(A, a, B, b, W, H, PAD, 'wpsvg');
    const span = xmap(muTimeFrac(A, a, B, b)), xs = sampleXs(series.length, span, xmap);
    const yOf = (v) => (PAD + (1 - v) * (H - 2 * PAD)).toFixed(1);
    const pts = (series.length ? series.map((v, i) => `${xs[i]},${yOf(v)}`) : [`0,${yOf(w)}`]).concat([`${span.toFixed(1)},${yOf(w)}`]);
    const mid = (PAD + .5 * (H - 2 * PAD)).toFixed(1);
    // the gradients live inside the chart so they need no shared <defs>: the
    // fill fades from each colour toward the middle; the STROKE is a hard
    // split at 50%, so the line wears the colour of whoever it favours
    // (both gradients are pinned to the chart, not to the shape they paint: a fill measured on its own
    // box put its halfway point above the midline whenever the line lived above it, and shaded teal's side blue)
    const defs = mk('defs', {}), grad = mk('linearGradient', { id: 'wpgrad', gradientUnits: 'userSpaceOnUse', x1: '0', y1: '0', x2: '0', y2: String(H) });
    [['0%', 'rgba(32,206,184,0.40)'], [`${(mid / H * 100).toFixed(2)}%`, 'rgba(32,206,184,0)'], [`${(mid / H * 100).toFixed(2)}%`, 'rgba(91,156,245,0)'], ['100%', 'rgba(91,156,245,0.40)']]
        .forEach(([o, c]) => grad.appendChild(mk('stop', { offset: o, 'stop-color': c })));
    const sgrad = mk('linearGradient', { id: 'wpstroke', gradientUnits: 'userSpaceOnUse', x1: '0', y1: '0', x2: '0', y2: String(H) });
    [['0%', '#20ceb8'], [`${(mid / H * 100).toFixed(2)}%`, '#20ceb8'], [`${(mid / H * 100).toFixed(2)}%`, '#5b9cf5'], ['100%', '#5b9cf5']]
        .forEach(([o, c]) => sgrad.appendChild(mk('stop', { offset: o, 'stop-color': c })));
    defs.appendChild(grad); defs.appendChild(sgrad); svg.appendChild(defs);
    svg.appendChild(mk('line', { x1: 0, x2: W, y1: mid, y2: mid, class: 'wpmid' }));
    if (series.length) {   // before kickoff there is only the dot: nothing has been played to trace
        svg.appendChild(mk('path', { d: `M0,${mid} L${pts.join(' L')} L${span.toFixed(1)},${mid} Z`, class: 'wpfill' }));
        svg.appendChild(mk('path', { d: `M${pts.join(' L')}`, class: 'wpline', stroke: 'url(#wpstroke)' }));
    }
    svg.appendChild(mk('circle', { cx: Math.max(3.6, Math.min(W - 3, span)).toFixed(1), cy: yOf(w), r: 3.6, class: `wpdot ${w >= 0.5 ? 'a' : 'b'}` }));
    // each play on the line: x by the football consumed when it ran, y read off the drawn line itself
    const L = S.ledger && S.ledger[S.week], line = pts.map((p) => p.split(',').map(Number));
    const lineY = (x) => { for (let i = 1; i < line.length; i++) if (line[i][0] >= x) { const [x0, y0] = line[i - 1], [x1, y1] = line[i]; return x1 > x0 ? y0 + (y1 - y0) * (x - x0) / (x1 - x0) : y1; } return line[line.length - 1][1]; };
    if (L && series.length) wpHover(box, svg, W, H, L.events.slice().reverse().filter((e) => e.x != null).map((e) => { const cx = Math.min(span, xmap(e.x)); return { cx, e, ys: [[lineY(cx), e.w >= 0.5 ? 'a' : 'b']] }; }),
        'wp', `${S.week}:${A && A.roster_id}:${B && B.roster_id}:wp`, L.settled, A, B);
    return box;
}
// Share of the matchup's projected points already consumed: the curve's
// frontier, and the POINTS lens's, sit at this fraction of the width.
function muTimeFrac(A, a, B, b) {
    const stAll = muStarters(A, a).concat(B ? muStarters(B, b) : []).filter(pid => pid && pid !== '0');
    const tot = stAll.reduce((t2, pid) => t2 + (projOf(pid, S.week) || 0), 0);
    const left = stAll.reduce((t2, pid) => t2 + (projOf(pid, S.week) || 0) * gameFracLeft(pid), 0);
    return tot > 0 ? Math.max(0.012, Math.min(1, 1 - left / tot)) : 1;
}
// Each history sample is plotted at the football consumed when it was taken
// (never past the frontier, never backwards), so a late-window play lands
// inside the late-window pane. Older memos without xhist spread evenly.
function sampleXs(n, span, xmap) {
    const L = S.ledger && S.ledger[S.week], xh = (L && L.xhist) || [];
    const out = []; let last = 0;
    for (let i = 0; i < n; i++) {
        let x = xh.length === n ? xmap(xh[i]) : (i / Math.max(1, n - 1)) * span;
        x = Math.min(span, Math.max(last, x)); last = x; out.push(x.toFixed(1));
    }
    return out;
}
// The frame both lenses share: the week's windows as panes on the x-axis —
// played ones recessed, the live one lit, hairlines between — and a foot
// strip naming them in the gauge rail's voice. The panes take the score
// bug's own box widths (measured after mount, see syncPanes), so the two
// cards line up window for window; until measured, projected-points share.
// Returns the svg to draw in, the box to hand back, and xmap: the share of
// the week's football consumed → x in the chart, pane by pane.
function chartFrame(A, a, B, b, W, H, PAD, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', cls); svg.style.height = H + 'px';
    const mk = (tag, attrs) => { const e = document.createElementNS(SVG_NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    const wins = muWindows(A, a, B, b) || [];
    const meas = S.ui.wpPanes && S.ui.wpPanes.length === wins.length ? S.ui.wpPanes : null;
    let cum = 0;
    const panes = wins.map((w2, i) => { const wd = meas ? meas[i] : w2.share, p = { p0: cum, p1: cum + wd, f0: w2.x0, f1: w2.x1 }; cum += wd; return p; });
    const xmap = (f) => {
        f = Math.max(0, Math.min(1, f));
        const p = panes.find(q => f <= q.f1) || panes[panes.length - 1];
        if (!p) return f * W;
        const t = p.f1 > p.f0 ? (f - p.f0) / (p.f1 - p.f0) : 1;
        return (p.p0 + Math.max(0, Math.min(1, t)) * (p.p1 - p.p0)) * W;
    };
    wins.forEach((w2, i) => { const p = panes[i];
        if (w2.done || w2.live) svg.appendChild(mk('rect', { x: (p.p0 * W).toFixed(1), y: 0, width: ((p.p1 - p.p0) * W).toFixed(1), height: H, class: `wpane ${w2.done ? 'played' : 'live'}` }));
        if (i > 0) svg.appendChild(mk('line', { x1: (p.p0 * W).toFixed(1), x2: (p.p0 * W).toFixed(1), y1: 0, y2: H, class: 'wdiv' }));
    });
    const foot = wins.length ? h('div', { class: 'wfoot' }, ...wins.map((w2, i) => h('span', { class: w2.live ? 'on' : '', style: `flex:${(panes[i].p1 - panes[i].p0).toFixed(4)} 0 0` }, `${w2.name}${w2.done ? ' ✓' : w2.live ? ' ●' : ''}`))) : null;
    // the chart stretches to the card (preserveAspectRatio none), so any
    // labels are HTML laid over it rather than svg text that would stretch too
    const box = h('div', { class: 'ptbox' }, svg, foot);
    return { svg, mk, box, xmap };
}
// ── hovering the curve ───────────────────────────────────────────────────────
// Point at the chart (or focus it and use ← →) and a guide line snaps to the
// last logged play at or before the pointer. The card's own rows show that
// moment: the score beside each name and the chance to win at the right with
// its change; the strip under the chart, where the windows are named, says the
// play. Nothing floats over the line. Leaving puts the live numbers back.
// One moment is held across live re-renders while the pointer stays put.
let wpHov = null;   // { key, t }: the chart and the play last pointed at
function wpWords(e) {
    if (e.kind === 'clock') return { names: 'Time ran out', lead: null, phrase: `${e.mins} more minute${e.mins === 1 ? '' : 's'} to the final whistle` };
    const who = (e.who || []).slice().sort((p, q) => Math.abs(q.dp || 0) - Math.abs(p.dp || 0)), first = who[0];
    let phrase = playPhrase(e.desc);
    if (first && ppos(first.pid) === 'QB') phrase = phrase.replace(/^TD catch/, 'TD pass').replace(/^catch,/, 'pass,');
    if (first && ppos(first.pid) === 'DEF') {
        if (/^sacked/.test(phrase)) phrase = phrase.replace(/^sacked/, 'sack');
        else if (/^(catch|run|pass|TD|XP|FG)/.test(phrase)) phrase += ' allowed';
    }
    return { names: who.map((w) => pname(w.pid)).join(' & '), lead: first ? first.pid : null, phrase };
}
function wpReadout(card, box, e, lens, final) {
    if (!card) return;
    card.__A = card.__A || box.__A; card.__B = card.__B || box.__B;
    const pct = (w) => `${final ? Math.round(w * 100) : Math.max(1, Math.min(99, Math.round(w * 100)))}%`;
    [['t', e.sa, e.w], ['b', e.sb, 1 - e.w]].forEach(([k, sc, w]) => {
        const row = card.querySelector(`.wprow.${k}`), n = row && row.querySelector('.n'); if (!n) return;
        if (n.dataset.live == null) n.dataset.live = n.textContent;
        row.querySelectorAll('.wphsc').forEach((x) => x.remove());
        // the rows hold the moment (score, chance); what the play changed is said once, in the strip
        if (lens === 'pts') n.textContent = fmtS(sc);
        else if (lens === 'proj') n.textContent = fmtS(k === 't' ? e.ta : e.tb);
        else {
            n.textContent = pct(w);
            const nm = row.querySelector('.nm2'); if (nm) nm.after(h('span', { class: 'wphsc mono' }, fmtS(sc)));
        }
    });
    const d = new Date(e.t), hr = d.getHours() % 12 || 12, at = `${hr}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'a' : 'p'}`;
    const pq = playQuarter(e.q), clock = e.kind === 'clock' ? 'FINAL' : pq ? `${pq} ${e.clk || ''}`.trim() : '';
    const wd = wpWords(e), strip = box.querySelector('.wpplay');
    // what the play did to its own side's chance (the clock's jump goes to whoever it helped)
    const own = e.kind === 'clock' ? Math.abs(e.dw) : (e.side === 'b' ? -e.dw : e.dw);
    const ownName = e.kind === 'clock' ? teamName(e.dw >= 0 ? card.__A : card.__B) : null;
    strip.replaceChildren(...[h('span', { class: 'tm' }, clock ? `${at} · ${clock}` : at),
        wd.lead ? h('img', { src: headshot(wd.lead), alt: '' }) : null,
        h('b', { class: `nm ${e.kind === 'clock' ? '' : e.side}` }, wd.names),
        h('span', { class: 'ph' }, wd.phrase),
        h('span', { class: 'end' },
            Math.abs(e.dp) >= 0.05 ? h('span', { class: `pts mono ${e.dp > 0 ? 'up' : 'dn'}` }, `${e.dp > 0 ? '+' : '−'}${fmtS(Math.abs(e.dp))} pts`) : null,
            // a change that rounds to nothing carries no arrow: an ▲ on 0.0% would claim a move that did not happen
            h('span', { class: `wdw mono ${Math.abs(own) < 0.0005 ? 'zero' : own > 0 ? 'up' : 'dn'}`, title: `How far this play moved ${ownName || (e.side === 'b' ? teamName(card.__B) : teamName(card.__A))}’s chance to win` }, Math.abs(own) < 0.0005 ? '0.0%' : `${own > 0 ? '▲' : '▼'} ${Math.abs(own * 100).toFixed(1)}%`))].filter(Boolean));
    strip.hidden = false;
}
function wpReadoutOff(card, box) {
    if (card) for (const n of card.querySelectorAll('.wprow .n')) { if (n.dataset.live != null) { n.textContent = n.dataset.live; delete n.dataset.live; } }
    if (card) card.querySelectorAll('.wphsc').forEach((x) => x.remove());
    const strip = box.querySelector('.wpplay'); if (strip) strip.hidden = true;
}
// evs: the plays in time order, each { cx, e, ys: [[y, class], …] } in the chart's own units
function wpHover(box, svg, W, H, evs, lens, key, settled, A, B) {
    // only plays that moved something: an incomplete pass the log keeps for the sweat changes neither
    evs = evs.filter((o) => o.e.kind === 'clock' || Math.abs(o.e.dw) >= 0.0005 || Math.abs(o.e.dp) >= 0.05);
    if (!evs.length) return;
    box.__A = A; box.__B = B;
    if (!box.querySelector('.wfoot')) box.append(h('div', { class: 'wfoot' }));   // the strip's room, held whether or not it shows
    const guide = h('i', { class: 'wpguide', hidden: true }), dots = evs[0].ys.map(() => h('i', { class: 'wphdot', hidden: true }));
    const strip = h('div', { class: 'wpplay', hidden: true, 'aria-live': 'polite' });
    const catcher = h('div', { class: 'wpcatch', tabindex: '0', role: 'img', 'data-focus': `wpchart:${lens}`,
        'aria-label': 'The chance to win through the week. Point at the line, or use the arrow keys, to see each play.' });
    box.append(guide, ...dots, catcher, strip);
    let cur = -1;
    const show = (i) => {
        const o = evs[i]; if (!o) return;
        cur = i; wpHov = { key, t: o.e.t };
        const r = svg.getBoundingClientRect(), sx = r.width / W, sy = r.height / H;
        guide.hidden = false; guide.style.left = `${o.cx * sx}px`; guide.style.height = `${r.height}px`;
        dots.forEach((dot, k) => { const [y, cls] = o.ys[k]; dot.hidden = false; dot.className = `wphdot ${cls}`; dot.style.left = `${o.cx * sx}px`; dot.style.top = `${y * sy}px`; });
        wpReadout(box.closest('.mwp'), box, o.e, lens, settled && i === evs.length - 1);
    };
    const hide = () => { cur = -1; wpHov = null; guide.hidden = true; dots.forEach((d) => { d.hidden = true; }); wpReadoutOff(box.closest('.mwp'), box); };
    const at = (clientX) => { const r = svg.getBoundingClientRect(), x = (clientX - r.left) / r.width * W; let pick = -1; for (let i = 0; i < evs.length && evs[i].cx <= x + 0.5; i++) pick = i; return pick; };
    catcher.addEventListener('pointermove', (ev) => { const i = at(ev.clientX); if (i < 0) hide(); else if (i !== cur) show(i); });
    catcher.addEventListener('pointerleave', () => { if (shadow.activeElement !== catcher) hide(); });
    catcher.addEventListener('focus', () => { const i = wpHov && wpHov.key === key ? evs.findIndex((o) => o.e.t === wpHov.t) : -1; show(i >= 0 ? i : evs.length - 1); });
    catcher.addEventListener('blur', hide);
    catcher.addEventListener('keydown', (ev) => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[ev.key];
        if (step) { ev.preventDefault(); show(Math.max(0, Math.min(evs.length - 1, (cur < 0 ? evs.length : cur) + step))); }
        else if (ev.key === 'Home' || ev.key === 'End') { ev.preventDefault(); show(ev.key === 'Home' ? 0 : evs.length - 1); }
        else if (ev.key === 'Escape') catcher.blur();
    });
    // a live re-render rebuilt the chart under a pointer that has not moved: hold the moment
    if (wpHov && wpHov.key === key) requestAnimationFrame(() => {
        if (!catcher.isConnected || !wpHov || wpHov.key !== key) return;
        const under = tipX >= 0 ? shadow.elementFromPoint(tipX, tipY) : null;
        if (under !== catcher && shadow.activeElement !== catcher) return;
        const i = evs.findIndex((o) => o.e.t === wpHov.t); show(i >= 0 ? i : at(tipX));
    });
}
// The score card's windows, sized from what they hold. Each window takes the width
// of the widest thing it carries, its box in either team's row or its name in the
// rail, the same in all three so the columns line up; growth shares out what is
// left. The flex basis muWindows sets is an estimate from older, smaller badges,
// and five of ten boxes were clipping their totals.
function fitGauges(page) {
    for (const card of page.querySelectorAll('.mscard')) {
        const rows = [...card.querySelectorAll('.mgrow')], rail = card.querySelector('.mgrail .wins');
        const cols = rows.map((r) => [...r.querySelectorAll(':scope > .mgseg')]).concat(rail ? [[...rail.children]] : []);
        const n = cols.length ? cols[0].length : 0;
        if (!n || cols.some((c) => c.length !== n)) continue;
        const fit = (e) => { const old = e.style.cssText; e.style.flex = 'none'; e.style.width = 'max-content'; const w = Math.ceil(e.getBoundingClientRect().width); e.style.cssText = old; return w; };
        for (let i = 0; i < n; i++) {
            const need = Math.max(...cols.map((c) => fit(c[i])));
            for (const c of cols) { const grow = parseFloat(c[i].style.flexGrow) || 1; c[i].style.flex = `${grow} 1 ${need}px`; }
        }
    }
}
// A drawer starts under the top bar and leaves it whole: the bar's buttons stay
// in reach while one is open, and the one that opened it closes it. The bar is
// shorter in a narrow window, so its height is measured, not assumed, and kept
// on the root, where the drawer's own rule reads it.
function syncBar() { const b = $('.topbar'); if (b && root) root.style.setProperty('--bar-h', `${b.offsetHeight}px`); }
// After a render, read the score bug's box widths and hand them to the
// curve's panes. A change re-renders once, synchronously — before paint, so
// nothing flickers — and the second pass measures the same and stops.
function syncPanes() {
    const row = $('.mscard .mgrow');
    const segs = row ? [...row.querySelectorAll('.mgseg')] : [];
    const ws = segs.map(e => e.getBoundingClientRect().width), tot = ws.reduce((t2, w2) => t2 + w2, 0);
    if (!tot) { if (S.ui.wpPanes) { S.ui.wpPanes = null; } return; }
    const fr = ws.map(w2 => w2 / tot), prev = S.ui.wpPanes || [];
    if (fr.length === prev.length && fr.every((v, i) => Math.abs(v - prev[i]) < 0.002)) return;
    S.ui.wpPanes = fr;
    if (S.ui.wpSyncing) return;   // one nested pass per render: a layout that will not settle must not spin
    S.ui.wpSyncing = true;
    try { render(); } finally { S.ui.wpSyncing = false; }
}
// The POINTS lens: two scores stepping up from zero across the football
// played, then dotted to their projected finals — so the chart's right edge
// agrees with the gauge's proj caps. A hollow ring at the frontier marks
// each side's pace: where the score would be on projection alone.
function ptsChart(A, a, B, b, o, W, H, PAD) {
    const L = S.ledger && S.ledger[S.week], ph = (L && L.phist) || [];
    const { svg, mk, box, xmap } = chartFrame(A, a, B, b, W, H, PAD, 'wpsvg pts');
    const span = xmap(muTimeFrac(A, a, B, b)), xs = sampleXs(ph.length, span, xmap);
    const cur = o.started ? [o.sA || 0, o.sB || 0] : [0, 0], fin = [o.fA || 0, o.fB || 0];
    const pace = [preProj(A, a), preProj(B, b)].map((pre, i) => pre - (fin[i] - cur[i]));   // pregame projection − what is still to play
    const top = Math.max(1, fin[0], fin[1], cur[0], cur[1], ...ph.map(p => Math.max(p[0], p[1]))) * 1.08;
    const y = (v) => (PAD + (1 - Math.max(0, v) / top) * (H - 2 * PAD)).toFixed(1);
    // faint quarter-lines give the eye a scale without an axis
    for (const q of [0.25, 0.5, 0.75]) svg.appendChild(mk('line', { x1: 0, x2: W, y1: y(top * q), y2: y(top * q), class: 'ptgrid' }));
    svg.appendChild(mk('line', { x1: span.toFixed(1), x2: span.toFixed(1), y1: PAD, y2: H - PAD, class: 'ptfront' }));
    ['a', 'b'].forEach((k, i) => {
        const pts = ph.length ? ph.map(p => p[i]) : [0];
        let d = `M0,${y(pts[0])}`;
        for (let j = 1; j < pts.length; j++) d += ` L${xs[j]},${y(pts[j - 1])} L${xs[j]},${y(pts[j])}`;
        d += ` L${span.toFixed(1)},${y(pts[pts.length - 1])} L${span.toFixed(1)},${y(cur[i])}`;
        svg.appendChild(mk('path', { d, class: `ptline ${k}` }));
        if (!o.done) {
            svg.appendChild(mk('path', { d: `M${span.toFixed(1)},${y(cur[i])} L${W},${y(fin[i])}`, class: `pttail ${k}` }));
            // pregame the rows already print the projections these tails climb to
            if (o.started) box.appendChild(h('span', { class: `ptlab ${k}`, style: `top:${y(fin[i])}px`, title: 'Projected final' }, fmt1(fin[i])));
            if (o.started) svg.appendChild(mk('circle', { cx: Math.max(3.6, Math.min(W - 3, span)).toFixed(1), cy: y(pace[i]), r: 3.4, class: `ptring ${k}` }));
        }
        svg.appendChild(mk('circle', { cx: Math.max(3.6, Math.min(W - 3, span)).toFixed(1), cy: y(cur[i]), r: 3.6, class: `ptdot ${k}` }));
    });
    // near-equal projections would stack their labels: the lower one drops under its line
    if (o.started && !o.done && Math.abs(y(fin[0]) - y(fin[1])) < 11) box.querySelector(`.ptlab.${fin[0] >= fin[1] ? 'b' : 'a'}`).classList.add('below');
    if (L && ph.length) wpHover(box, svg, W, H, L.events.slice().reverse().filter((e) => e.x != null).map((e) => ({ cx: Math.min(span, xmap(e.x)), e, ys: [[+y(e.sa), 'a'], [+y(e.sb), 'b']] })),
        'pts', `${S.week}:${A && A.roster_id}:${B && B.roster_id}:pts`, L.settled, A, B);
    return box;
}
// The PROJECTED lens (the user, 2026-10-25): each side's projected final after every play (points scored plus
// what its starters still to play are projected for), so the line says how the expected result moved; flat on
// to the right edge, where the projection stands now.
function projChart(A, a, B, b, o, W, H, PAD) {
    const L = S.ledger && S.ledger[S.week], evs = L ? L.events.filter((e) => e.x != null && e.ta != null).reverse() : [];
    const { svg, mk, box, xmap } = chartFrame(A, a, B, b, W, H, PAD, 'wpsvg pts');
    const span = xmap(muTimeFrac(A, a, B, b)), start = [preProj(A, a), preProj(B, b)], fin = [o.fA || 0, o.fB || 0];
    const vals = evs.flatMap((e) => [e.ta, e.tb]).concat(start, fin), lo0 = Math.min(...vals), hi0 = Math.max(...vals), pad = Math.max(2, (hi0 - lo0) * 0.15);
    const lo = lo0 - pad, hi = hi0 + pad, y = (v) => (PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD)).toFixed(1), cx = Math.max(3.6, Math.min(W - 3, span)).toFixed(1);
    for (const q of [0.25, 0.5, 0.75]) svg.appendChild(mk('line', { x1: 0, x2: W, y1: y(lo + (hi - lo) * q), y2: y(lo + (hi - lo) * q), class: 'ptgrid' }));
    svg.appendChild(mk('line', { x1: span.toFixed(1), x2: span.toFixed(1), y1: PAD, y2: H - PAD, class: 'ptfront' }));
    ['a', 'b'].forEach((k, i) => {
        let d = `M0,${y(start[i])}`, prev = start[i];
        for (const e of evs) { const x = Math.min(span, xmap(e.x)).toFixed(1), v = i ? e.tb : e.ta; d += ` L${x},${y(prev)} L${x},${y(v)}`; prev = v; }
        d += ` L${span.toFixed(1)},${y(prev)} L${span.toFixed(1)},${y(fin[i])}`;
        svg.appendChild(mk('path', { d, class: `ptline ${k}` }));
        if (!o.done) svg.appendChild(mk('path', { d: `M${span.toFixed(1)},${y(fin[i])} L${W},${y(fin[i])}`, class: `pttail ${k}` }));
        box.appendChild(h('span', { class: `ptlab ${k}`, style: `top:${y(fin[i])}px`, title: 'Projected final' }, fmt1(fin[i])));
        svg.appendChild(mk('circle', { cx, cy: y(fin[i]), r: 3.6, class: `ptdot ${k}` }));
    });
    if (Math.abs(y(fin[0]) - y(fin[1])) < 11) box.querySelector(`.ptlab.${fin[0] >= fin[1] ? 'b' : 'a'}`).classList.add('below');
    if (L && evs.length) wpHover(box, svg, W, H, evs.map((e) => ({ cx: Math.min(span, xmap(e.x)), e, ys: [[+y(e.ta), 'a'], [+y(e.tb), 'b']] })),
        'proj', `${S.week}:${A && A.roster_id}:${B && B.roster_id}:proj`, L.settled, A, B);
    return box;
}
function preProj(R, m) { return R ? muStarters(R, m).reduce((t2, pid) => t2 + (pid && pid !== '0' ? projOf(pid, S.week) || 0 : 0), 0) : 0; }
function bestStarter(R) { let best = null, bv = -1; starterSlots().forEach((s, i) => { const pid = (R.starters || [])[i]; const v = projOf(pid, S.week) || 0; if (pid && pid !== '0' && v > bv) { bv = v; best = pid; } }); return best ? `${(P(best) || {}).last_name || pname(best)} (${fmt1(bv)})` : '—'; }
function avatarEl(R, cls) { const u = R && teamAvatar(R); return h('div', { class: `avatar ${cls || ''}` }, u ? h('img', { src: u, alt: '' }) : initials(R ? teamName(R) : '?')); }
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
// Divisions, when the league has them: one section per division, ranked
// within, division name from league metadata.
// ── lineup efficiency ────────────────────────────────────────────────────────
// Actual starter points ÷ the best legal lineup from that week's ACTUAL
// scores, summed over completed weeks (optimal clamped to ≥ actual). Computed
// here from Sleeper's own weekly points.
// The best legal lineup is FBCalc's exact bitmask search. This used to fill
// strict slots first and take the best eligible body,
// which a superflex breaks: greedy burns the QB in the flex and leaves the QB
// slot to a backup. Every bench-points number moved slightly when it changed.
function optimalPointsFrom(m) {
    const pp = (m && m.players_points) || {};
    const ids = (m.players || Object.keys(pp)).filter(pid => pp[pid] != null);
    const players = ids.map(pid => {
        const pl = P(pid);
        const pos = (pl && pl.fantasy_positions && pl.fantasy_positions.length) ? pl.fantasy_positions.join(',') : (ppos(pid) || null);
        return { pts: pp[pid] || 0, elig: FBCalc.eligOf(pos) };
    });
    return FBCalc.optimalLineup(players, FBCalc.slotsFromRosterPositions(rosterPositions()));
}
// ── standings, one row builder for both the flat and division tables ─────────
// One standings component for both eras: the live table leads with rank, the
// vault's with the bracket's Finish. All-play is the scoreboard's diagnostic —
// record with the schedule removed; the judgment layer (luck, bench) lives in
// the ledger, not here.
let stCtx = null;   // { ap, vault: { finish, pts } | null } — set by standingsTable
function allPlayMap(live) {
    const end = regSeasonEnd(), out = {};
    const div = {}; for (const R of S.rosters) { out[R.roster_id] = { w: 0, l: 0, dw: 0, dl: 0, dt: 0 }; div[R.roster_id] = (R.settings || {}).division || 0; }
    for (let w = 1; w <= end && (w < S.curWeek || (live && w === S.curWeek)); w++) {
        const rows = (S.matchups[w] || []).filter(m => m.matchup_id != null && out[m.roster_id]);
        const ptsOf = new Map(rows.map((m) => [m, live && w === S.curWeek ? countedPoints(m) : m.points || 0]));   // the week in progress at its projected final
        for (const m of rows) for (const o of rows) { if (o === m) continue; const a = ptsOf.get(m), b = ptsOf.get(o); if (a > b) out[m.roster_id].w++; else if (a < b) out[m.roster_id].l++; else { out[m.roster_id].w += 0.5; out[m.roster_id].l += 0.5; } }
        // division record: the ACTUAL pairings, when both sides share a division
        const by = {}; for (const m of rows) (by[m.matchup_id] = by[m.matchup_id] || []).push(m);
        for (const pair of Object.values(by)) if (pair.length === 2) {
            const [x, y] = pair;
            if (!div[x.roster_id] || div[x.roster_id] !== div[y.roster_id]) continue;
            const a = ptsOf.get(x), b = ptsOf.get(y);
            if (a > b) { out[x.roster_id].dw++; out[y.roster_id].dl++; }
            else if (b > a) { out[y.roster_id].dw++; out[x.roster_id].dl++; }
            else { out[x.roster_id].dt++; out[y.roster_id].dt++; }
        }
    }
    return out;
}
// Which rules the seeds on screen follow, said in a line under the table. A
// league can run a rule its Sleeper settings cannot hold (a seat for the most
// points, say); that rule is not known here, and the line says the seeds do
// not count it.
function seedingNote() {
    const nDiv = ((S.league && S.league.settings) || {}).divisions || 0;
    return `Seeds follow Sleeper’s default rules: ${nDiv >= 2 ? 'division winners first, then the best records' : 'the best records'}, ties on points for. `
        + 'A league rule that Sleeper’s settings cannot hold, such as a seat for the most points, is not counted here.';
}
// Today's seeds: the rulebook applied to the table as it stands — a fact, not
// a forecast, and the same interpreter the sim uses. Empty until a week is
// final, because twelve 0–0s seed by roster id and that is not information.
function currentSeeds(live) {
    if (S.seasonType !== 'regular' || !(S.curWeek > 1) || !S.rosters) return null;
    const book = poDefaultRules();
    const st = S.league.settings || {}, playoffTeams = Math.min(st.playoff_teams || 6, S.rosters.length);
    const teams = S.rosters.map(R => ({ rid: R.roster_id, w: (R.settings || {}).wins || 0, l: (R.settings || {}).losses || 0, t: (R.settings || {}).ties || 0, pf: pf(R), division: (R.settings || {}).division || 0 }));
    if (!teams.some(t => t.w + t.l + t.t > 0)) return null;
    const H = {}, key = (a, b) => a + ':' + b;
    const last = live ? S.curWeek : S.curWeek - 1, byRid = Object.fromEntries(teams.map((t) => [t.rid, t]));
    for (let w = 1; w <= last && w <= regSeasonEnd(); w++) {
        const by = {}; for (const m of (S.matchups[w] || [])) if (m.matchup_id != null) (by[m.matchup_id] = by[m.matchup_id] || []).push(m);
        for (const p of Object.values(by)) if (p.length === 2) {
            const [x, y] = p, now = live && w === S.curWeek, a = now ? countedPoints(x) : x.points || 0, b = now ? countedPoints(y) : y.points || 0;
            if (a > b) H[key(x.roster_id, y.roster_id)] = (H[key(x.roster_id, y.roster_id)] || 0) + 1;
            else if (b > a) H[key(y.roster_id, x.roster_id)] = (H[key(y.roster_id, x.roster_id)] || 0) + 1;
            // the week in progress also counts toward the record and points, at its projected final
            if (live && w === S.curWeek) {
                const tx = byRid[x.roster_id], ty = byRid[y.roster_id]; if (!tx || !ty) continue;
                tx.pf += a; ty.pf += b;
                if (a > b) { tx.w++; ty.l++; } else if (b > a) { ty.w++; tx.l++; } else { tx.t++; ty.t++; }
            }
        }
    }
    // Input order is the interpreter's last tiebreak, so hand it the table by
    // record then points — a still-tied cluster then lands sensibly.
    teams.sort((a, b) => (b.w - a.w) || (b.pf - a.pf));
    const res = FBCalc.applyRules(book, teams, (a, b) => [H[key(a, b)] || 0, H[key(b, a)] || 0], playoffTeams);
    const out = {};
    res.seeds.forEach((sd, i) => { const rule = book.seeds[sd.rule] || {}; out[sd.rid] = { n: i + 1, bye: i < res.byes, how: rule.take === 'division_winners' ? 'div' : rule.take === 'most_pf' ? 'pts' : 'wc' }; });
    return out;
}
// A roster's chance of a seat: the share of the simulated seasons it made it in.
function inPctOf(rid) {
    const res = S.po && S.po.res, t = res && res.teams && res.teams.get(rid);
    if (t && res.n) return Math.round(100 * t.in_ / res.n);
    return null;
}
function standingsHead(compact) {
    const vault = stCtx && stCtx.vault;
    const live = compact && !vault;   // the Home card: seeds and chances; the vault and the full table keep their columns
    return h('tr', null, h('th', { class: live ? 'c' : '' }, vault ? 'Fin' : live ? 'Seed' : '#'), h('th', null, 'Team'),
        h('th', { class: 'r' }, 'W–L'),
        (((S.league.settings || {}).divisions || 0) >= 2) ? h('th', { class: 'r c-div', title: 'Record against your own division' }, 'Div') : null,
        h('th', { class: 'r c-ap', title: 'All-play: record if every team played every other team, every week — the schedule removed' }, 'All-play'),
        h('th', { class: 'r' }, 'PF'), h('th', { class: 'r c-pa' }, 'PA'),
        compact ? null : h('th', null, 'Surplus'),
        vault ? null : h('th', { class: 'r c-faab' }, waiverInfo().faab ? 'FAAB' : 'Waiver'),
        vault ? null : live ? h('th', { class: 'c', title: 'Chance of a playoff seat: the season played out 3,000 times from today\'s rosters and projections, seeded by this league\'s own rules. Before any results it is roster strength and schedule alone.' }, 'Playoff %')
            : h('th', { class: 'r', title: 'Adds, drops and trades this season' }, 'Moves'),
        compact ? null : h('th', { class: 'r' }, 'Proj wk'), compact ? null : h('th', null, ''));
}
function standingsRow(R, i, compact) {
    const mine = S.myRoster && R.roster_id === S.myRoster.roster_id, sp = surplus(R);
    const vault = stCtx && stCtx.vault;
    const fin = vault && vault.finish ? vault.finish[R.roster_id] : null;
    const ap = stCtx && stCtx.ap && stCtx.ap[R.roster_id];
    const apPlayed = ap && (ap.w + ap.l > 0);
    const live = compact && !vault;
    const seeds = live ? stCtx.seeds : null, sd = seeds && seeds[R.roster_id];
    const inp = live ? inPctOf(R.roster_id) : null;
    const played = S.curWeek > 1;
    // the week in progress, as it stands: this roster's live line, and where it sat on settled weeks
    // (the marker is the League tab's: places moved in the overall order, seeds first)
    const lv = stCtx && stCtx.lv ? stCtx.lv[R.roster_id] : null;
    const at0 = lv ? stCtx.pos.was[R.roster_id] : null, at1 = lv ? stCtx.pos.now[R.roster_id] : null;
    const mover = lv && at0 && at1 && at0 !== at1
        ? h('span', { class: `lvmv ${at0 > at1 ? 'up' : 'dn'}`, title: `${ordinal(at0)} on settled weeks, ${ordinal(at1)} ${liveWord()}` }, `${at0 > at1 ? '▲' : '▼'}${Math.abs(at0 - at1)}`) : null;
    // as it stands, the seed and its mover share a row, the mover's slot held whether or not it is filled
    const seedCell = (inner) => lv ? h('span', { class: 'sdrow' }, inner, mover || h('span', { class: 'lvmv', 'aria-hidden': 'true' })) : inner;
    return h('tr', { class: mine ? 'hl' : '' },
        h('td', { class: `dim mono${live ? ' c' : ''}` }, vault ? (fin === 1 ? '\u{1F3C6}' : fin ? ordinal(fin) : '\u2014')
            : sd ? seedCell(h('span', { class: 'sdcell', title: sd.how === 'div' ? 'Division champ today' : sd.how === 'pts' ? 'The points seat today' : 'Wild card today' }, h('span', { class: `sdbadge${sd.how === 'pts' ? ' pts' : ''}` }, sd.n), sd.bye ? h('span', { class: 'sdcap' }, 'BYE') : null))
            : live ? seedCell(stCtx.pos && stCtx.pos.now[R.roster_id] ? h('span', { class: 'sdnone', title: `${ordinal(stCtx.pos.now[R.roster_id])} overall, outside the playoff seats` }, stCtx.pos.now[R.roster_id]) : h('span', { class: 'sdnone dash' }, '\u2014')) : i + 1),
        h('td', { style: `font-weight:800;${mine ? 'color:var(--teal)' : ''}` }, h('div', { class: 'tcell' }, avatarEl(R, 'sm'),
            vault ? h('span', null, teamName(R)) : teamLink(R),
            vault && vault.pts && vault.pts.has(R.roster_id) ? h('span', { class: 'chip amber', style: 'font-size:9px;margin-left:6px' }, 'points seat') : null)),
        h('td', { class: 'r mono' }, lv ? `${lv.w}\u2013${lv.l}${lv.t ? '\u2013' + lv.t : ''}` : record(R), lv && lv.res ? h('span', { class: 'lvres', title: `Week ${S.curWeek} ${liveWord()}: ${fmtS(lv.pts)}\u2013${fmtS(lv.opp)}` }, h('i'), lv.res) : null),
        (((S.league.settings || {}).divisions || 0) >= 2) ? h('td', { class: 'r mono dim c-div' }, ap && (ap.dw + ap.dl + ap.dt > 0) ? `${ap.dw}\u2013${ap.dl}${ap.dt ? '\u2013' + ap.dt : ''}` : '\u2014') : null,
        h('td', { class: 'r mono c-ap', title: apPlayed ? `${Math.round(100 * ap.w / (ap.w + ap.l))}% of every possible matchup won` : 'Fills in once games are played' }, apPlayed ? `${Math.round(ap.w)}\u2013${Math.round(ap.l)}` : '\u2014'),
        h('td', { class: 'r mono', title: lv ? `${fmt1(pf(R))} settled + ${fmt1(lv.pts)} ${liveWeekProjects() ? 'projected ' : ''}this week` : null }, fmt1(lv ? lv.pf : pf(R))), h('td', { class: 'r mono dim c-pa', title: lv ? `${fmt1(pa(R))} settled + ${fmt1(lv.opp)} ${liveWeekProjects() ? 'projected ' : ''}this week` : null }, fmt1(lv ? lv.pa : pa(R))),
        compact ? null : h('td', null, sp ? [h('span', { class: `pos ${sp.pos}` }, posLabel(sp.pos)), ` \u00d7${sp.n}`] : h('span', { class: 'dim' }, '\u2014')),
        vault ? null : h('td', { class: 'r mono c-faab' }, waiverInfo().faab ? `$${faabLeft(R)}` : R.settings.waiver_position),
        vault ? null : live ? h('td', { class: 'c' }, inp == null ? h('span', { class: 'dim' }, '\u2014')
                : h('span', { class: 'inwrap' }, h('span', { class: 'inbar' }, h('i', { class: inp < 25 ? 'lo' : '', style: `width:${inp}%` })), h('span', { class: `inpct ${!played ? 'mute' : inp >= 60 ? 'hi' : inp >= 25 ? 'mid' : 'lo'}` }, `${inp}%`)))
            : h('td', { class: 'r mono dim' }, (R.settings || {}).total_moves || 0),
        compact ? null : h('td', { class: 'r mono' }, fmt1(projTotal(R, S.week))),
        compact ? null : h('td', null, mine ? '' : h('button', { class: 'btn sm s', onclick: () => openTrade(R.roster_id) }, 'Trade')));
}
function divisionStandings(compact) {
    loadSeasonMatchups();   // all-play needs every completed week
    const nDiv = ((S.league.settings || {}).divisions || 0);
    const meta = S.league.metadata || {};
    const head = standingsHead(compact);
    const tbl = h('table', null, head);
    // Count the header's own cells rather than keeping a number in step by
    // hand. standingsHead drops Div, Surplus, Proj wk and the trade button
    // depending on the league and the caller, and the hardcoded 8/11 stopped
    // being right the day Div arrived — leaving the division banner one column
    // short of the table's edge.
    const ncols = head.children.length;
    for (let d = 1; d <= nDiv; d++) {
        const rows = rosterRank(stCtx && stCtx.lv).filter(R => ((R.settings || {}).division || 0) === d);
        if (!rows.length) continue;
        tbl.append(h('tr', { class: 'secrow' }, h('td', { colspan: ncols }, h('b', null, meta[`division_${d}`] || `Division ${d}`))));
        rows.forEach((R, i) => tbl.append(standingsRow(R, i, compact)));
    }
    return h('div', { class: 'scroll-x sttbl' }, tbl);
}
function standingsTable(compact, vaultCtx) {
    loadSeasonMatchups();   // all-play needs every completed week
    // the Home card can count the week in progress as it stands: one switch, shared with the League tab
    const asIs = compact && !vaultCtx && sheetLiveOn();
    stCtx = { ap: allPlayMap(asIs), vault: vaultCtx || null, seeds: compact && !vaultCtx ? currentSeeds(asIs) : null,
        lv: asIs ? liveStand() : null, was: asIs ? (currentSeeds(false) || {}) : null };
    // every team's place in the overall order, settled and as it stands: the seats in seed order, then the rest by record and points
    // (the place also names the teams outside the seats: 7th to last, where a dash used to sit)
    if (compact && !vaultCtx && stCtx.seeds) {
        const place = (seeds, lv) => { const o = {}; rosterRank(lv).map((R) => R.roster_id).sort((x, y) => ((seeds[x] || {}).n || 99) - ((seeds[y] || {}).n || 99)).forEach((rid, i) => { o[rid] = i + 1; }); return o; };
        stCtx.pos = { was: asIs ? place(stCtx.was, null) : null, now: place(stCtx.seeds, stCtx.lv) };
    }
    const nDiv = ((S.league.settings || {}).divisions || 0);
    // under the Home card's table: the week as it stands, when on, and which rules seeded it
    const note = compact && !vaultCtx && stCtx.seeds ? seedingNote() : null;
    const under = [asIs ? homeLiveCap() : null, note ? h('div', { class: 'cap seednote' }, note) : null].filter(Boolean);
    if (nDiv >= 2) return under.length ? h('div', null, divisionStandings(compact), ...under) : divisionStandings(compact);
    const tbl = h('table', null, standingsHead(compact));
    rosterRank(stCtx.lv).forEach((R, i) => tbl.append(standingsRow(R, i, compact)));
    if (under.length) return h('div', null, h('div', { class: 'scroll-x sttbl' }, tbl), ...under);
    return h('div', { class: 'scroll-x sttbl' }, tbl, compact ? null : h('div', { class: 'cap' }, 'All-play = your record if you had played every team every week — the schedule removed. Surplus = position with more startable players than slots — the trade map. Lineup efficiency lives in the Ledger as points left on the bench.'));
}
function txnRow(t) {
    const who = (rid) => { const R = rosterById(rid); return R ? teamName(R) : `Roster ${rid}`; };
    const adds = Object.entries(t.adds || {}), drops = Object.entries(t.drops || {});
    const ico = t.type === 'trade' ? '⇄' : t.type === 'waiver' ? '⏳' : t.type === 'commissioner' ? '⚙' : '＋';
    let body;
    if (t.type === 'trade') {
        const sides = (t.roster_ids || []).map(rid => `${who(rid)} gets ${adds.filter(([, r]) => r === rid).map(([p]) => pname(p)).concat((t.draft_picks || []).map(normPick).filter(dp => dp.owner_id === rid).map(pickLabel)).join(', ') || 'nothing'}`);
        body = h('div', null, h('b', null, t.status === 'complete' ? 'Trade' : `Trade ${t.status}`), ' ', h('span', { class: 'muted' }, sides.join(' · ')));
    } else {
        const rid = (t.roster_ids || [])[0];
        body = h('div', null, h('b', null, who(rid)), ' ', h('span', { class: 'muted' }, t.type === 'waiver' ? (t.status === 'complete' ? 'claimed' : t.status === 'failed' ? 'failed to claim' : 'claim on') : 'added'), ' ', adds.map(([p]) => pname(p)).join(', ') || h('span', { class: 'dim' }, '—'),
            drops.length ? [' ', h('span', { class: 'muted' }, '· dropped'), ' ', drops.map(([p]) => pname(p)).join(', ')] : null,
            t.settings && t.settings.waiver_bid != null ? [' ', h('span', { class: 'mono dim' }, `$${t.settings.waiver_bid}`)] : null);
    }
    return h('div', { class: 'it' }, h('div', { class: 'ico' }, ico), body, h('div', { class: 'when' }, ago(t.status_updated || t.created)));
}
function newsFeed(pids, limit) {
    const items = pids.map(pid => ({ pid, n: S.news[pid] })).filter(x => x.n).sort((a, b) => b.n.published - a.n.published).slice(0, limit || 8);
    const feed = h('div', { class: 'feed' });
    if (!items.length) feed.append(h('div', { class: 'empty' }, Object.keys(S.news).length ? 'No recent news on your players.' : 'Loading news…'));
    for (const { pid, n } of items) {
        const md = n.metadata || {};
        feed.append(h('div', { class: 'it', style: 'grid-template-columns:1fr auto;align-items:start' }, h('div', null, h('div', { class: 'news-t' }, h('span', { class: 'teal', style: 'cursor:pointer', onclick: () => { S.ui.sel = pid; render(); } }, pname(pid)), ' — ', md.title || ''), h('div', { class: 'news-d' }, (md.description || md.analysis || '').slice(0, 220))), h('div', { class: 'when' }, ago(n.published))));
    }
    return feed;
}
// GraphQL hands draft picks back as "roster_id,season,round,owner_id,previous_owner_id"
// strings where REST gives objects; read both.
function normPick(dp) {
    if (dp && typeof dp === 'object') return dp;
    const [roster_id, season, round, owner_id, previous_owner_id] = String(dp).split(',');
    return { roster_id: Number(roster_id), season, round: Number(round), owner_id: Number(owner_id), previous_owner_id: Number(previous_owner_id) };
}
function pickLabel(dp) { const from = rosterById(dp.roster_id); return `${dp.season} R${dp.round}${from && dp.roster_id !== dp.owner_id ? ' (' + teamName(from).slice(0, 12) + ')' : ''}`; }
function tradeSummary(t) {
    const my = S.myRoster; const rid = my ? my.roster_id : null;
    const picks = (t.draft_picks || []).map(normPick);
    const get = Object.entries(t.adds || {}).filter(([, r]) => r === rid).map(([p]) => (P(p) || {}).last_name || p).concat(picks.filter(dp => dp.owner_id === rid && dp.previous_owner_id !== rid).map(pickLabel));
    const give = Object.entries(t.drops || {}).filter(([, r]) => r === rid).map(([p]) => (P(p) || {}).last_name || p).concat(picks.filter(dp => dp.previous_owner_id === rid).map(pickLabel));
    const other = (t.roster_ids || []).filter(r => r !== rid).map(r => { const R = rosterById(r); return R ? teamName(R).slice(0, 16) : 'Roster ' + r; }).join(', ');
    if (!get.length && !give.length) return `with ${other || '?'}: ${picks.length ? picks.map(pickLabel).join(', ') : 'see Sleeper'}`;
    return `${give.join(' + ') || 'nothing'} for ${get.join(' + ') || 'nothing'}${other ? ' · ' + other : ''}`;
}

// ── Team ─────────────────────────────────────────────────────────────────────
// The week's lineup as checks, each passing or to fix with the reason, and the one fix for those a lineup can fix:
// the best projected lineup, its flex set the late-flex way. Set best lineup's window lists them all (the user,
// 2026-10-14: the window should "outline the checks and which approved/failed"; the flex is one of them now, not a
// button of its own, and the byes went to Weeks ahead).
// What you chose to keep this week, overriding a check that is a judgment call (the user, 2026-10-14: "should i be
// able to override certain rules? Like i may want to leave someone questionable in"): a questionable starter you
// leave in, a starter you keep from a suggested swap, the flex slots left as they are. A sure zero (an empty slot, a
// bye, OUT) and Sleeper's IR rule are never overridden. A choice holds for the week it was made, and a questionable
// man's only while his status is the one you kept him at. Kept in this browser, per league and week.
const LKEEP = () => 'badgerLineupKeep-' + S.leagueId;
function lineupKeeps() {
    if (!S.lkeep || S.lkeep.league !== S.leagueId) { let all = {}; try { all = JSON.parse(localStorage.getItem(LKEEP()) || '{}') || {}; } catch (e) { all = {}; } S.lkeep = { league: S.leagueId, all }; }
    const all = S.lkeep.all;
    for (const w of Object.keys(all)) if (Number(w) < Math.max(1, S.curWeek)) delete all[w];   // the week turned
    const k = all[S.week] = all[S.week] || { q: {}, best: {}, flex: false };
    return { k, save: () => { try { localStorage.setItem(LKEEP(), JSON.stringify(all)); } catch (e) { /* kept for this visit */ } render(); } };
}
// The best lineup's men, moved as little as they can be: a man who stays keeps his slot and a newcomer takes a
// vacated one he fits, so leaving the flex slots alone does not reshuffle the rest. Falls back to `best` as built.
function keepSlots(cur, best) {
    const bestSet = new Set(best.filter(p => p && p !== '0')), out = cur.map(p => (p && p !== '0' && bestSet.has(p)) ? p : '0');
    for (const p of best) { if (!p || p === '0' || out.includes(p)) continue; const i = starterSlots().findIndex((sl, k) => out[k] === '0' && slotEligible(sl, p)); if (i < 0) return best; out[i] = p; }
    return out;
}
// The week's lineup as checks, each passing, to fix, or kept by you, with the reason, and the one fix for those a
// lineup can fix: the best projected lineup, its flex set the late-flex way. Set best lineup's window lists them
// all (the user, 2026-10-14: the window should "outline the checks and which approved/failed"; the flex is one of
// them now, not a button of its own, and the byes went to Weeks ahead).
function lineupChecks(my) {
    const slots = starterSlots(), cur = my.starters || [], wk = S.week, { k } = lineupKeeps();
    const curStart = cur.filter(p => p && p !== '0');
    const zero = (pid) => isBye(pid, wk) || /out|ir|pup|sus/i.test(statusOf(pid) || '');
    const keptQ = curStart.filter(p => k.q[p] != null && k.q[p] === (statusOf(p) || ''));
    const keptBest = curStart.filter(p => k.best[p] && !zero(p)), pinned = new Set([...keptQ, ...keptBest]);
    const raw = bestLineup(my, wk, pid => muLocked(pid) || pinned.has(pid));
    const lf0 = lateFlex(my, wk), flexKept = !!k.flex && !!lf0 && lf0.moves.length > 0;
    const arranged = flexKept ? null : lateFlex(my, wk, raw), best = arranged ? arranged.starters : keepSlots(cur, raw);
    const gain = best.reduce((t, pid) => t + (pid !== '0' ? (projOf(pid, wk) || 0) : 0), 0) - projTotal(my, wk);
    const bestSet = new Set(best.filter(p => p && p !== '0'));
    // Who comes in for whom. A newcomer into a slot that is empty now replaces nobody; the rest pair by position, not
    // by slot, or a reshuffle reads as a chain of swaps. (With an empty QB slot, Ward read as "in for Tucker" and the
    // back who really took Tucker's spot as "for the empty slot".)
    const outs = curStart.filter(p => !bestSet.has(p)), changes = [];
    const news = best.map((p, i) => ({ p, i })).filter(x => x.p && x.p !== '0' && !curStart.includes(x.p));
    for (const x of news) if (!cur[x.i] || cur[x.i] === '0') x.from = null, x.done = true;
    for (const x of news.filter(x => !x.done)) { let i = outs.findIndex(o => ppos(o) === ppos(x.p)); if (i < 0) i = outs.findIndex(o => cur.indexOf(o) === x.i); if (i < 0 && outs.length) i = 0; x.from = i >= 0 ? outs.splice(i, 1)[0] : null; }
    for (const x of news) changes.push({ to: x.p, from: x.from, at: slots[x.i] });
    const lf = flexKept ? null : lf0;
    const flexMoves = changes.length ? (arranged ? arranged.moves.filter(m => curStart.includes(m.pid)) : []) : (lf ? lf.moves : []);
    const fix = changes.length ? best : flexMoves.length ? lf.starters : null, after = fix || cur;
    const issues = lineupIssues(my), of = (kind) => issues.filter(x => x.kind === kind);
    const and = (list) => list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
    const benchBye = (my.players || []).filter(p => !curStart.includes(p) && !(my.reserve || []).includes(p) && isBye(p, wk));
    const st = (ok) => ok ? 'pass' : 'fix';
    const checks = [
        { key: 'empty', state: st(!of('empty').length), title: 'Every slot filled', why: of('empty').map(x => `${slotLabel(x.slot)} is empty`).join(' · '),
            left: of('empty').filter(x => (after[x.i] || '0') === '0').map(x => `Nobody on your bench can fill ${slotLabel(x.slot)}: look on the wire.`) },
        { key: 'bye', state: st(!of('bye').length), title: 'Nobody on bye', why: of('bye').length ? of('bye').map(x => `${lastNm(x.pid)} is on bye`).join(' · ') : benchBye.length ? `${and(benchBye.map(lastNm))} ${benchBye.length === 1 ? 'is' : 'are'} on bye, on your bench` : '',
            left: of('bye').filter(x => after.includes(x.pid)).map(x => `Nobody on your bench can take ${lastNm(x.pid)}’s place.`) },
        { key: 'out', state: st(!of('out').length), title: 'Nobody out', why: of('out').map(x => x.text).join(' · '),
            left: of('out').filter(x => after.includes(x.pid)).map(x => `Nobody on your bench can take ${lastNm(x.pid)}’s place.`) },
    ];
    const qItems = [];
    slots.forEach((slot, i) => {
        const pid = cur[i]; if (!pid || pid === '0') return;
        const sx = insNormStatus(statusOf(pid)); if (!sx || !INS_MAYBE.test(sx.toLowerCase())) return;
        const kk = insKickInfo(pid); if (kk && (kk.started || kk.over)) return;   // already playing: not a decision
        const cov = lateCover(pid, slot), when = kk ? atWhen(Date.parse(kk.t)) : 'kickoff unknown';
        qItems.push({ pid, kept: keptQ.includes(pid), text: `${lastNm(pid)} is ${sx.toLowerCase()}, plays ${when}: ${cov ? `if he sits, ${lastNm(cov.pid)} (${atWhen(cov.ts)}) can still go in after` : 'nobody on your bench plays later, so decide before then'}.` });
    });
    checks.push({ key: 'q', state: !qItems.length ? 'pass' : qItems.every(x => x.kept) ? 'kept' : 'fix', title: 'No questionable starters', items: qItems,
        left: qItems.filter(x => !x.kept && after.includes(x.pid)).map(x => `${lastNm(x.pid)} stays in until you say: leave him in, or swap him on the roster below.`) });
    checks.push({ key: 'best', state: changes.length ? 'fix' : keptBest.length ? 'kept' : 'pass', title: 'Your best projected lineup', kept: keptBest,
        why: changes.map(c => `${pname(c.to)} (${fmt1(projOf(c.to, wk))}) is on your bench`).join(' · '), left: [] });
    if (lf0) {
        const holders = slots.map((sl, i) => FLEX[sl] && cur[i] && cur[i] !== '0' ? cur[i] : null).filter(Boolean);
        checks.push({ key: 'flex', state: !lf0.moves.length ? 'pass' : flexKept ? 'kept' : 'fix', title: 'Flex holds your latest kickoff', left: [], keepable: lf0.moves.length > 0,
            why: lf0.moves.length ? lf0.moves.map(m => `${lastNm(m.pid)} belongs in ${slotLabel(m.to)}`).join(' · ')
                : lf0.oneKickoff ? 'Every starter kicks off at the same time'
                : [holders.map(p => `${lastNm(p)}, ${atWhen(lf0.when(p))}`).join(' · '), lf0.pinned ? `${pname(lf0.pinned.pid)} plays later, but every ${posLabel(lf0.pinned.sl)} slot needs one` : ''].filter(Boolean).join('. ') });
    }
    if (((S.league.settings || {}).reserve_slots || 0) > 0) {
        const bad = (my.reserve || []).filter(p => !irStatusOk(p));
        checks.push({ key: 'ir', state: st(!bad.length), title: 'IR spots hold only the injured', why: bad.map(p => `${pname(p)} is ${(statusOf(p) || 'healthy').toLowerCase()}, so Sleeper blocks adds and drops until he comes off IR`).join(' · '),
            left: bad.map(p => `${lastNm(p)} is not part of it: activating him takes a roster spot, so someone may have to be dropped. Do that on the roster below.`) });
    }
    return { checks, fix, changes, flexMoves, gain, flexKept };
}
const checkMark = (state) => sv('svg', { class: `lcmk ${state === 'pass' ? 'ok' : state === 'kept' ? 'kp' : 'no'}`, width: 16, height: 16, viewBox: '0 0 16 16', role: 'img', 'aria-label': state === 'pass' ? 'passes' : state === 'kept' ? 'kept' : 'fails' },
    sv('circle', { cx: 8, cy: 8, r: 8, class: 'bg' }),
    state === 'pass' ? sv('path', { d: 'M4.6 8.3l2.4 2.4 4.4-4.8', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
        : state === 'kept' ? sv('path', { d: 'M4.8 8h6.4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round' })
        : sv('path', { d: 'M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round' }));
function pageTeam() {
    const page = h('div', { class: 'page wide' });
    if (!S.rosters.length) { page.append(h('div', { class: 'card' }, 'Loading rosters…')); return page; }
    const my = viewedTeam();
    if (!my) { page.append(h('div', { class: 'card' }, 'You do not manage a team in this league. Rosters are on the League page.')); return page; }
    const mine = S.myRoster && my.roster_id === S.myRoster.roster_id;
    const lc = mine ? lineupChecks(my) : null, fails = lc ? lc.checks.filter(c => c.state === 'fix').length : 0, kept = lc ? lc.checks.filter(c => c.state === 'kept').length : 0;
    const pop = S.ui.teamPop;
    const popCard = (kind) => {
        if (kind !== 'best' || !lc) return null;
        const { k, save } = lineupKeeps();
        const left = lc.checks.filter(c => c.state === 'fix').flatMap(c => c.left || []);
        const link = (act, pid, label, fn) => h('button', { class: 'lnk', type: 'button', 'data-act': act, 'data-pid': pid || null, onclick: (ev) => { ev.stopPropagation(); fn(); save(); } }, label);
        // the reason under a check, with the overrides a judgment call allows
        const why = (c) => {
            if (c.key === 'q' && c.items && c.items.length) return c.items.map((it, n) => [n ? ' ' : '', it.kept
                ? ['You’re leaving ', h('b', null, lastNm(it.pid)), ` in for week ${S.week}. `, link('keep-undo', it.pid, 'undo', () => { delete k.q[it.pid]; })]
                : [it.text, ' ', link('keep-q', it.pid, 'Leave him in', () => { k.q[it.pid] = statusOf(it.pid) || ''; })]]);
            if (c.key === 'best' && c.kept && c.kept.length) return [c.why ? `${c.why}. ` : '', 'You’re keeping ', c.kept.map((p2, n) => [n ? ' and ' : '', h('b', null, lastNm(p2))]), ' in. ', link('keep-undo', null, 'undo', () => { k.best = {}; })];
            if (c.key === 'flex' && c.state === 'kept') return ['You’re leaving the slots as they are. ', link('keep-undo', null, 'undo', () => { k.flex = false; })];
            if (c.key === 'flex' && c.keepable) return [c.why, '. ', link('keep-flex', null, 'Leave the slots', () => { k.flex = true; })];
            return c.why || null;
        };
        const inRow = (ch) => h('div', { class: 'lcmv' }, ch.to === '0' ? h('span') : h('img', { class: 'hs', src: headshot(ch.to), alt: '', onerror: hideBroken }),
            h('div', { style: 'min-width:0' }, h('b', null, pname(ch.to)), ' in at ', h('b', null, slotLabel(ch.at)), ', for ', ch.from ? h('b', null, pname(ch.from)) : 'the empty slot',
                h('div', { class: 'd' }, [(P(ch.to) || {}).team, kickoffLabel((P(ch.to) || {}).team)].filter(Boolean).join(' · '),
                    ch.from ? [' · ', link('keep-best', ch.from, `Keep ${lastNm(ch.from)}`, () => { k.best[ch.from] = true; })] : null)),
            h('span', { class: 'lcg' }, `+${fmt1((projOf(ch.to, S.week) || 0) - (ch.from ? projOf(ch.from, S.week) || 0 : 0))}`));
        const flexRow = (m) => h('div', { class: 'lcmv' }, slotChip(m.to, null, [m.pid]),
            h('div', { style: 'min-width:0' }, h('b', null, pname(m.pid)), ` to ${slotLabel(m.to)}`, h('div', { class: 'd' }, `${m.q ? `${statusOf(m.pid)} · ` : ''}${kickoffLabel((P(m.pid) || {}).team) || 'kickoff unknown'}${m.from ? ` · now ${slotLabel(m.from)}` : ''}`)), h('span'));
        const pass = lc.checks.length - fails - kept;
        return h('div', { class: 'hpop lcpop', role: 'dialog', 'aria-label': `Week ${S.week} lineup`, onclick: (ev) => ev.stopPropagation() },
            h('div', { class: 'lch' }, h('b', null, `Week ${S.week} lineup`), h('span', { class: 'm' }, [`${pass} pass`, kept ? `${kept} kept` : null, `${fails} to fix`].filter(Boolean).join(' · '))),
            ...lc.checks.map(c => { const w = why(c);
                return h('div', { class: `lck ${c.state}`, 'data-check': c.key, 'data-state': c.state }, checkMark(c.state), h('b', null, c.title), w ? h('span', { class: 'd' }, w) : null, h('span', { class: 'v' }, c.state === 'pass' ? 'PASS' : c.state === 'kept' ? 'KEPT' : 'FIX')); }),
            lc.fix ? h('div', { class: 'lcfh' }, 'The fix') : null,
            ...(lc.fix ? [...lc.changes.map(inRow), ...lc.flexMoves.map(flexRow)] : []),
            lc.fix || left.length ? h('div', { class: 'lcff' }, lc.fix ? h('button', { class: 'btn p sm', 'data-act': 'lineup-apply', onclick: () => { S.ui.teamPop = null; applyBest(lc.fix, lc.changes, lc.flexMoves); } }, 'Apply') : null,
                left.length ? h('span', { class: 'lcnote' }, left.join(' ')) : null) : null,
            h('div', { class: 'cap' }, 'Sleeper’s projections, this league’s scoring. Byes and OUT count as zero. The flex gets a questionable starter first, then your latest kickoff: a late scratch there can be covered from any position. What you keep holds for this week; Apply never undoes it.'));
    };
    const chipBtn = (kind, label, cls) => h('span', { style: 'position:relative' }, h('button', { class: `btn sm ${cls || ''}`, 'data-pop': kind, onclick: (ev) => { ev.stopPropagation(); S.ui.teamPop = pop === kind ? null : kind; render(); } }, label), pop === kind ? popCard(kind) : null);
    page.append(h('div', { class: 'card', onclick: () => { if (S.ui.teamPop) { S.ui.teamPop = null; render(); } } },
        h('div', { class: 'card-h teamhd', style: 'margin-bottom:0' },
            h('div', { style: 'display:flex;align-items:center;gap:12px' }, avatarEl(my, 'lg'), h('div', null, teamSwitcher(my), h('div', { class: 'dim', style: 'font-size:12px' }, `${record(my)} · ${ordinal(rosterRank().findIndex(r => r.roster_id === my.roster_id) + 1)} · ${fmt1(pf(my))} PF · ${waiverInfo().faab ? '$' + faabLeft(my) + ' FAAB' : 'waiver #' + my.settings.waiver_position} · proj ${fmt1(projTotal(my, S.week))}`)),
                null),
            h('div', { class: 'row-actions' },
                // One button for the lineup; claims, trades and adds live in Transactions (the user, 2026-10-14)
                lc ? chipBtn('best', `${lc.fix ? `Set best lineup${lc.changes.length ? ` (+${fmt1(lc.gain)})` : ''}` : fails ? 'Lineup' : 'Lineup ✓'}${fails ? ` · ${fails} to fix` : ''}`, lc.fix ? 'p' : fails ? 'warn' : 's') : null,
                mine ? null : h('button', { class: 'btn sm', 'data-act': 'trade-open', onclick: () => openTrade(my.roster_id) }, `Trade with ${teamName(my).slice(0, 14)}`),
                mine ? null : h('button', { class: 'btn sm s', onclick: () => goTeam(S.myRoster.roster_id) }, '← My team')))));
    if (mine && S.seasonType === 'regular') { const wa = weeksAheadFold(my); if (wa) page.append(wa); }
    page.append(rosterCard(my, !mine));
    return page;
}
function teamSwitcher(R) {
    const open = S.ui.teamMenu;
    const menu = open ? h('div', { class: 'pdmenu', style: 'width:300px', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'pdhd' }, 'TEAMS'),
        h('div', { class: 'pdscroll' }, ...rosterRank().map((T, i) => h('div', {
            class: `mi ${T.roster_id === R.roster_id ? 'on' : ''}`,
            onclick: () => goTeam(T.roster_id),
        }, h('span', { class: 'tcell' }, h('span', { class: 'dim mono', style: 'width:14px;flex:none' }, i + 1), avatarEl(T, 'sm'), h('span', { style: 'overflow:hidden;text-overflow:ellipsis' }, `${teamName(T)}${S.myRoster && T.roster_id === S.myRoster.roster_id ? ' (you)' : ''}`)), h('span', { class: 'mono' }, record(T)))))) : null;
    return h('div', { class: 'pdd', style: 'display:block', onclick: (e) => e.stopPropagation() },
        h('h3', { class: `tswitch${S.ui.teamMenu ? ' open' : ''}`, title: 'Switch team', role: 'button', tabindex: '0', onclick: () => { S.ui.teamMenu = !S.ui.teamMenu; render(); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.ui.teamMenu = !S.ui.teamMenu; render(); } } },
            teamName(R), caret('tcar')), menu);
}
async function act(fn, okText) {
    try { await fn(); toast(okText || 'Done', 'ok'); await refreshAfterAction(); }
    catch (e) { console.error(TAG, e); toast(String(e.message || e), 'err'); }
}
async function refreshAfterAction() {
    S.rosters = await rest(`${API}/league/${S.leagueId}/rosters`);
    S.myRoster = S.rosters.find(r => String(r.owner_id) === String(S.myUserId) || (r.co_owners || []).map(String).includes(String(S.myUserId))) || null;
    S.txns[S.week] = null; S.matchups[S.week] = null; S.legs[S.week] = null; S.waivers = null;
    await Promise.all([loadTxns(S.week), loadMatchups(S.week), loadLegs(S.week), loadPending(), loadWaivers(), reloadLineups()]);
    syncLineups();
    render();
}
async function applyBest(best, changes, flexMoves) {
    const f = (flexMoves || []).length;
    await act(() => setStarters(best), `Lineup set — ${changes.length} change${changes.length === 1 ? '' : 's'}${f ? `, ${f} slot move${f === 1 ? '' : 's'} for the flex` : ''}`);
}
function playerCell(pid, week, o) {
    const pl = P(pid) || {};
    const pos = ppos(pid), nk = o && o.nick ? nickOf(pid) : null;
    return h('div', { class: 'pl' }, h('div', { class: 'avatar sm' }, h('img', { src: headshot(pid), alt: '', onerror: (e) => { e.target.remove(); } })),
        h('div', { style: 'min-width:0' }, nameLine(pid), nk ? h('div', { class: 'nick', title: `“${nk}”` }, h('q', null, nk)) : null, h('div', { class: 'sub' }, bioText(pid))));
}
// Team and bye ride with the name now; age and experience drop to the sub-line.
function teamMeta(pid, noBye) {
    const pl = P(pid) || {}, bye = noBye ? null : byeWeekOf(pl.team);
    // A D/ST's name is its team, so it only wants the bye in parentheses.
    if (ppos(pid) === 'DEF') return bye ? h('span', { class: 'tmeta' }, `(${bye})`) : null;
    return h('span', { class: 'tmeta' }, `${pl.team || 'FA'}${bye ? ` (${bye})` : ''}`);
}
function bioText(pid) {
    const pl = P(pid) || {};
    return [pl.age ? `Age ${pl.age}` : null, pl.years_exp === 0 ? 'Rookie' : pl.years_exp ? `${pl.years_exp} yr${pl.years_exp === 1 ? '' : 's'}` : null].filter(Boolean).join(' \u00b7 ');
}
// The second line follows the game: its kickoff before, the quarter and the
// score while it is on, the result once it is over, his team's score first.
// It read "Sun 10:00a" under games that had finished hours before.
function oppGameLine(pid, week) {
    const pl = P(pid) || {}, m = week === S.kickWeek ? S.kick : (S.kickByWeek || {})[week], k = m && pl.team ? m[pl.team] : null;
    if (!k) return week < S.curWeek ? { txt: 'Final', cls: 'fin' } : null;
    const fin = k.over || k.q === 'F' || /complete|closed/i.test(k.status || ''), half = k.q === 'H' || (k.qn === 2 && k.tr === '00:00');
    const on = !fin && (k.live || k.started || Date.parse(k.t) < Date.now());
    if (!fin && !on) return null;
    const home = k.home === pl.team, us = Number(home ? k.hs : k.as), them = Number(home ? k.as : k.hs), known = isFinite(us) && isFinite(them) && (k.hs != null || k.as != null);
    const sc = known ? `${us}–${them}` : '';
    if (fin) return { txt: known ? `${us > them ? 'W' : us < them ? 'L' : 'T'} ${sc}` : 'Final', cls: 'fin', title: known ? `Final: ${pl.team} ${us}, ${k.home === pl.team ? k.away : k.home} ${them}` : null };
    const clock = half ? 'HALF' : `${quarterLabel(k)}${k.tr && k.tr !== '00:00' ? ' ' + k.tr : ''}`;
    return { txt: `${clock}${sc ? ' · ' + sc : ''}`, cls: 'live', clock, sc };
}
function oppCell(pid, week) {
    const g = gameOf(pid, week);
    if (!g) return h('td', { class: 'mono dim' }, isBye(pid, week) ? 'BYE' : '—');
    const pl = P(pid) || {}, st = oppGameLine(pid, week);
    const ko = (week === S.week ? kickoffLabel(pl.team) : null) || DAY[new Date(g.date + 'T12:00:00').getDay()];
    return h('td', { class: 'mono oppc' }, h('div', null, `${g.home ? 'vs ' : '@'}${g.opp}`, oppRankEl(pid, week)),
        // live, the clock and the score are two pieces that wrap onto their own lines in a narrow column: one line,
        // "Q3 14:55 · 0–10", needed 117px and was cut off in the roster's 86 and the Players table's 92 (2026-10-18)
        st && st.cls === 'live' ? h('div', { class: 'ogl live', title: st.txt }, h('span', null, h('i', { class: 'oglive' }), st.clock), st.sc ? h('b', { class: 'oglsc' }, st.sc) : null)
            : st ? h('div', { class: `ogl ${st.cls}`, title: st.title || null }, st.txt) : h('div', { class: 'ogl' }, ko));
}
function statusChip(pid, week) {
    if (isBye(pid, week)) return h('span', { class: 'chip red' }, 'Bye');
    const s = statusOf(pid); if (!s) return null;
    const pl = P(pid); const bad = /out|ir|pup|sus/i.test(s);
    return h('span', { class: `chip ${bad ? 'red' : 'amber'}`, title: pl.injury_notes || '' }, `${s}${pl.injury_body_part ? ' · ' + pl.injury_body_part : ''}`);
}
// Four stat groups; the strips above the stat columns are the only labels.
const GROUPS = { QB: 'QB', RB: 'SKILL', WR: 'SKILL', TE: 'SKILL', K: 'K', DEF: 'DEF' };
// The box score is one set, drawn the same on the roster and on Players and the
// same under Proj and Actual: a position's own band, then rushing in the last
// three columns for a quarterback and every skill position alike. Nothing in it
// is a number Sleeper does not project — red-zone work, air yards and snaps are
// usage, and live there.
const BOX_REC = [['rec_tgt', 'TGT'], ['rec', 'REC'], ['rec_yd', 'RE YD'], ['rec_td', 'RE TD']];
const BOX_RUSH = [['rush_att', 'CAR'], ['rush_yd', 'RU YD'], ['rush_td', 'RU TD']];
const GROUP_STATS = {
    QB: [['pass_att', 'ATT'], ['pass_yd', 'PA YD'], ['pass_td', 'PA TD'], ['pass_int', 'INT'], ...BOX_RUSH],
    SKILL: [...BOX_REC, ...BOX_RUSH],
    K: [['fgm', 'FGM'], ['fga', 'FGA'], ['fgm_40_49', '40-49'], ['fgm_50p', '50+'], ['xpm', 'XPM'], ['xpa', 'XPA']],
    DEF: [['sack', 'SACK'], ['int', 'INT'], ['fum_rec', 'FR'], ['td', 'TD'], ['yds_allow', 'YDS A'], ['pts_allow', 'PTS A'], ['safe', 'SFTY']],
};
const STAT_N = 7;
// Usage on the Team page is the deep view: for each position, Sleeper's whole
// usage set — the Players tab's — led by the rest-of-season projection, with
// the column to scan first leading the numbers, so a cut can be judged from the roster.
const ROS_COL = () => ['ros', 'ROS', `Rest of season: weeks ${Math.max(1, S.curWeek)}–${LAST_WEEK}, Sleeper's projection in this league's scoring, with his rank at the position`];
const USAGE_N = 11;   // ROS and the skill grid's ten
// His rank at the position by Sleeper's rest-of-season projection.
const rosRanks = new WeakMap();
function rosRank(pid) {
    const m = S.ros; if (!m) return null;
    let r = rosRanks.get(m);
    if (!r) { r = {}; const by = {}; for (const [p2, x] of Object.entries(m)) (by[ppos(p2)] = by[ppos(p2)] || []).push([p2, x.pts || 0]);
        for (const arr of Object.values(by)) { arr.sort((a, b) => b[1] - a[1]); arr.forEach(([p2], i) => { r[p2] = i + 1; }); } rosRanks.set(m, r); }
    return r[pid] || null;
}
const deepView = () => isUsage(S.ui.basis);
// Insight is advice about the lineup to come, so it rides with the projection. Every other view is a record of
// what happened, and its numbers get the room: on a laptop the column was the part cut off at the right.
const insightShown = () => !(['wkActual', 'seasActual', 'l4Actual'].includes(S.ui.basis) || deepView());
const statN = () => isUsage(S.ui.basis) ? USAGE_N : STAT_N;
// Under Usage the roster is one grid. Every back, receiver and tight end reads
// under the same labels in the fixed order, so a number is in the same column
// all the way down and the labels are drawn once for the run. A quarterback's
// numbers take the slots that answer the same question: attempts where snaps
// are, his own carries where a back's are. A kicker or defence keeps its box score.
const slotCols = (set) => set.map(k => k == null ? [null, '', ''] : [k, USAGE[k][0], USAGE[k][1]]);
function teamStatSet(group, pos) {

    if (!isUsage(S.ui.basis) || group === 'K' || group === 'DEF') return GROUP_STATS[group];
    return [ROS_COL(), ...slotCols(group === 'QB' ? QB_SLOTS : USAGE_SETS.SKILL)];
}
const l4Basis = () => S.ui.basis === 'usageL4' || S.ui.basis === 'l4Actual';
const stripKeyOf = (group) => group;
function groupOf(pid) { return GROUPS[ppos(pid)] || 'SKILL'; }
function groupStatVal(line, key) {
    if (!line || !line.stats) return null;
    const v = groupStatRaw(line, key);
    return v != null && line.tm && line.gp > 1 ? v / line.gp : v;   // the last four: per game
}
function groupStatRaw(line, key) {
    const st = line.stats;
    if (key === 'yds') return st.rush_rec_yd ?? (((st.rush_yd || 0) + (st.rec_yd || 0)) || null);
    if (key === 'tds') return st.anytime_tds ?? (((st.rush_td || 0) + (st.rec_td || 0)) || null);
    if (key === 'pts_allow') return st.pts_allow ?? st.fan_pts_allow ?? null;
    if (key === 'td') return st.td ?? st.def_td ?? null;   // Sleeper projects a defence's touchdowns as def_td
    return st[key] ?? null;
}
// Which way a usage number is better. One that is not listed is a style and not
// a grade — how deep a man catches the ball — and is never ranked.
const GRADE = { opp: 1, snp: 1, rz: 1, tsh: 1, ypt: 1, ryac: 1, csh: 1, ypc: 1, yco: 1, att: 1, cmp: 1, ypa: 1, sck: -1 };
// His rank at the position in one number, among the players with a real role
// over the same games, and the level that puts the number at. Four levels, read
// off this league: inside the top twelve (one a team), among the rest of the
// players the league starts at the position, within a team's worth past them,
// and beyond. The number is drawn at its level, so the eye finds the strong
// ones before it has read any. The rank itself is said when the number is
// pointed at: printed under every number it was a second table on top of the first.
const levelOf = (rk, n, started) => { const st = Math.max(n, started >= 4 ? started : 2 * n); return rk <= n ? 1 : rk <= st ? 2 : rk <= st + n ? 3 : 4; };
const startedAt = (pos) => S.rosters.flatMap((r) => r.starters || []).filter((p) => p && p !== '0' && ppos(p) === pos).length;
function statRank(d, v, way) {
    if (!d || v == null || !way) return null;
    const rk = d.pop.filter((p) => way * p[0] > way * v).length + 1;
    return { rk, of: d.pop.length, step: levelOf(rk, d.g.n, d.g.started) };
}
const rankSays = (pos, r, work) => `${ordinal(r.rk)} of the ${r.of} ${posLabel(pos)}s on the field for a quarter of their team’s snaps${work ? `, with ${work.per} ${work.word[1]} a game` : ''}`;
const levelWord = (step) => { const n = S.rosters.length || 12; return ['', `top ${n}`, 'starter', `next ${n}`, 'beyond'][step] || ''; };
// What a number says when it is pointed at: his rank, then what is behind the figure, a line each.
const say = (pos, rk, step, lines) => ({ 'data-say': lines.filter(Boolean).join('\n'), 'data-rank': `${posLabel(pos)}${rk}`, 'data-step': String(step) });
// What the levels are, in a line under the table.
const levelKey = () => { const n = S.rosters.length || 12;
    return h('span', { class: 'lvkey' }, 'A number is drawn by where it ranks at his position:', h('b', { class: 'lv1' }, `top ${n}`), h('b', { class: 'lv2' }, 'a starter in this league'), h('b', { class: 'lv3' }, `the next ${n}`), h('b', { class: 'lv4' }, 'beyond'), 'Point at one for his rank.'); };
// A rate needs work behind it before it is ranked. One catch on one target is 32
// yards a target, and set against men with forty targets it led the position.
// So a rate is ranked only for a man with enough of what it is "per", a game,
// over his games in view, and only against the others who have it. Passing
// follows the NFL's own qualifier, 14 attempts a game, and rushing sits a shade
// under its 6.25 carries. Sacks are a count, but fewer is better, so a
// quarterback who hardly dropped back would lead those too. A style, such as
// how deep his catches come, is never ranked, but it is a rate as well: on too
// little it is drawn dim like the rest, where one deep catch had it shining.
const RATE_UNIT = { ypt: 'tgt', ypc: 'car', cmp: 'att', ypa: 'att', sck: 'att', adoc: 'rec', aircmp: 'att' };
const rateUnit = (k) => RATE_UNIT[k];
const RATE_MIN = { tgt: { WR: 3, TE: 3, RB: 2 }, rec: { WR: 2, TE: 2, RB: 1.5 }, car: { RB: 6, QB: 2 }, att: { QB: 14 } };
const RATE_STAT = { tgt: 'rec_tgt', rec: 'rec', car: 'rush_att', att: 'pass_att' }, RATE_WORD = { tgt: ['target', 'targets'], rec: ['catch', 'catches'], car: ['carry', 'carries'], att: ['pass attempt', 'pass attempts'] };
function workFor(line, pos, unit) {
    const st = (line && line.stats) || {}, games = line && line.gp > 1 ? line.gp : 1, have = st[RATE_STAT[unit]] || 0, per = (RATE_MIN[unit] || {})[pos] || 1;
    return { have, per, games, ok: have >= per * games, word: RATE_WORD[unit] };
}
const workSays = (w, style) => `${w.have} ${w.word[w.have === 1 ? 0 : 1]} over ${w.games} game${w.games === 1 ? '' : 's'}. It takes ${w.per} a game to ${style ? 'go by' : 'be ranked'}.`;
const unranked = (w, style) => ({ 'data-say': workSays(w, style), 'data-rank': style ? 'Too little to go by' : 'Not ranked', 'data-step': '0' });
// Which way a number is going: his last four games against his season, for a man
// with more games than the four. A share has moved at five points, as the
// roster's own marks say; anything else when it has gone a quarter of the way
// from the middle of his position to its top scorers. Less than that is steady,
// and steady carries no mark.
function moveOf(pid, pos, k) {
    if (!GRADE[k]) return null;
    const l4 = l4Pool(), sea = S.seasonStats, a = l4 && l4[pid], b = sea && sea[pid]; if (!a || !b || !(b.gp > a.gp)) return null;
    const now = usageVal(a, k), was = usageVal(b, k, sea); if (now == null || was == null) return null;
    const unit = rateUnit(k); if (unit && !(workFor(a, pos, unit).ok && workFor(b, pos, unit).ok)) return null;   // a rate that moved on a handful of plays has not moved
    let step = 0.05;
    if (USAGE[k][2] !== 'pct') { const d = usageDist(sea, pos, k, (e) => { const x = usageVal(e, k, sea); return x == null && USAGE_ZERO.has(k) ? 0 : x; }); if (!d || d.top == null) return null;
        const n = d.pop.length, mid = (d.pop[(n - 1) >> 1][0] + d.pop[n >> 1][0]) / 2; step = Math.abs(d.top - mid) / 4; if (!step) return null; }
    return { tone: Math.abs(now - was) < step ? 'flat' : (now - was) * GRADE[k] > 0 ? 'up' : 'down', now, was, games: a.gp };
}
const moveMark = (m) => m && m.tone !== 'flat' ? h('span', { class: `trend ${m.tone}` }, m.tone === 'up' ? '\u25b2' : '\u25bc') : null;
// His season, week by week, each week read against its own team totals: this
// week and the last four from the weeks in hand, older ones from his own game
// log and the totals saved for that week. Each week is a line to read, a reason
// there is none, or null while it loads. The player card draws it.
function seasonWeeks(pid) {
    const G = (S.gameLog || {})[pid]; if (!G && S.seasonType === 'regular') loadGameLog(pid).then(render).catch(() => {});
    const team = (P(pid) || {}).team, upto = S.seasonType === 'regular' ? Math.min(LAST_WEEK, S.curWeek) : 0;
    const weekOf = (w) => {
        const pl = S.stats[w]; let ln = null;
        if (pl) ln = pl[pid] || null;
        else { if (!G || G.loading) return null; const e = G.st && G.st[String(w)]; if (e && e.stats) { const tm = weekTeamTotals(w, e.team || team); if (tm === undefined) return null; ln = { pid, stats: e.stats, tm }; } }
        if (ln && ln.stats && ((ln.stats.off_snp || 0) > 0 || (ln.stats.gp || 0) > 0)) return { ln, pl };
        if (w === S.curWeek && !teamGameOver(pid, w)) return { why: null };   // still to play: nothing to mark yet
        const sched = S.schedule && S.schedule[w];
        return { why: sched && Object.keys(sched).length && team && !sched[team] ? 'bye' : 'did not play' };
    };
    const season = []; for (let w = 1; w <= upto; w++) season.push([w, weekOf(w)]);
    return season;
}
const seriesFrom = (season, get) => season.map(([w, x]) => { if (!x) return [w, undefined]; if (!x.ln) return [w, null, x.why]; const v = get(x.ln, x.pl); return v != null && isFinite(v) ? [w, v] : [w, null, 'no number for this one']; });
// Where a share stands against the season, beside the last four games' figure:
// up or down when it moved five points, and nothing when it held: a dash there
// read as a minus sign. It marks the snap
// share and the position's own share, carries for a back and targets for a
// receiver. Only a player with more games than the four gets one: before that
// the two figures are the same figure. It used to be a card of its own above
// the roster, a full-width chart for seven pairs of numbers.
const TREND_KEYS = { RB: ['snp', 'csh'], WR: ['snp', 'tsh'], TE: ['snp', 'tsh'] };
function shareTrend(pid, k) {
    if (!(TREND_KEYS[ppos(pid)] || []).includes(k)) return null;
    const l4 = l4Pool(), sea = S.seasonStats, a = l4 && l4[pid], b = sea && sea[pid];
    if (!a || !b || !(b.gp > a.gp)) return null;
    const now = usageVal(a, k), was = usageVal(b, k, sea); if (now == null || was == null) return null;
    const d = now - was, pc = (v) => `${Math.round(v * 100)}%`; if (Math.abs(d) < 0.05) return null;
    return h('span', { class: `trend ${d > 0 ? 'up' : 'down'}`, title: `season ${pc(was)} \u2192 last ${a.gp} games ${pc(now)}` }, d > 0 ? '\u25b2' : '\u25bc');
}
// The deep view's cells: ROS, then each number, every one drawn at its level at
// the position and saying his rank when pointed at; over the season an arrow
// leads a number whose last four games moved against it. It used to be a bar
// under every number, then his rank under every number.
// What is behind an opportunity figure, in counts: the carries and targets it was built from.
const oppWork = (line) => { const st = line && line.stats; if (!st) return null; const g = line.gp > 1 ? line.gp : 1, c = (st.rush_att || 0) / g, t = (st.rec_tgt || 0) / g;
    return [c >= 0.5 ? `${fmt1(c)} carries` : null, `${fmt1(t)} targets`].filter(Boolean).join(' + ') + (line.gp > 1 ? ' a game' : ''); };
function deepCells(pid, group) {
    const pos = ppos(pid), line = statLine(pid, S.ui.basis), pool = basisPool(S.ui.basis);
    const key = keyColFor(pos);

    const quiet = (pos === 'WR' || pos === 'TE') && (usageVal(line, 'csh', pool) || 0) < 0.05;
    const cells = teamStatSet(group, pos).map(([fk]) => {
        if (fk == null || (quiet && U_RUSH.includes(fk))) return h('td');
        if (fk === 'ros') { const r = (S.ros || {})[pid], rk = r ? rosRank(pid) : null, lv = rk ? levelOf(rk, S.rosters.length || 12, startedAt(pos)) : 0;
            return h('td', Object.assign({ class: `r mono${lv ? ' lv' + lv : ''}` }, lv ? say(pos, rk, lv, [`${ordinal(rk)} at his position in Sleeper’s rest-of-season projection`]) : null), r ? fmt0(r.pts) : h('span', { class: 'dim' }, S.rosLoading ? '…' : '—')); }
        const k = fk;
        const get = (e) => { const x = usageVal(e, k, pool); return x == null && USAGE_ZERO.has(k) ? 0 : x; };
        const show = (x) => usageFmt(k, x);
        const v = line ? get(line) : null;
        const cls = `r mono${fk === key ? ' keycol' : ''}`;
        if (v == null) return h('td', { class: cls }, h('span', { class: 'dim' }, '—'));
        const d = pool && usageDist(pool, pos, fk, get), way = GRADE[k];
        const unit = rateUnit(fk), work = unit ? workFor(line || (pool && pool[pid]), pos, unit) : null, short = !!work && !work.ok;   // too little behind a rate: not ranked, and drawn dim
        const r = short ? null : statRank(d, v, way);

        const mv = S.ui.basis === 'usageS' ? moveOf(pid, pos, fk) : null;   // over the season, which way his last four games went
        const why = [r ? rankSays(pos, r, work) : null, fk === 'opp' ? oppWork(line) : null, mv ? `last ${mv.games} games ${usageFmt(fk, mv.now)}, season ${usageFmt(fk, mv.was)}` : null].filter(Boolean);
        // a style has no rank to say, but its season is still worth a look
        const style = !way && !short && USAGE[fk] ? { 'data-say': 'A style, not a grade: it carries no rank.', 'data-rank': USAGE[fk][0], 'data-step': '0' } : null;
        const td = h('td', Object.assign({ class: cls + (r ? ` lv${r.step}` : short ? ' lv0' : '') }, r ? say(pos, r.rk, r.step, why) : short ? unranked(work, !way) : style || { title: why.join(' \u00b7 ') || null }),
            l4Basis() ? shareTrend(pid, fk) : moveMark(mv), show(v));
        if (d && USAGE[fk] && (r || short || style)) { td.sayMore = () => seasonTip(pid, pos, fk, d, show); td.sayPid = pid; }   // held there, the tooltip draws his season
        return td;
    });
    while (cells.length < statN()) cells.push(h('td'));
    return cells;
}
function groupStatCells(pid, group) {

    if (deepView() && group !== 'K' && group !== 'DEF') return deepCells(pid, group);
    const line = statLine(pid, S.ui.basis), set = teamStatSet(group, ppos(pid));
    // a receiver's rushing columns stay empty until he has carried the ball
    const runs = group !== 'SKILL' || ppos(pid) === 'RB' || (groupStatVal(line, 'rush_att') || 0) >= 0.5;
    const cells = set.map(([k]) => {
        if (!runs && k.startsWith('rush')) return h('td');
        const v = groupStatVal(line, k);
        return h('td', { class: 'r mono' }, v == null ? h('span', { class: 'dim' }, '—') : Number.isInteger(v) ? fmt0(v) : fmt1(v));
    });
    while (cells.length < statN()) cells.push(h('td'));
    return cells;
}
function stripRow(group, pos) {
    // sticky 4-col lead (the frozen zone) · the points col · the stat labels · insight
    const set = teamStatSet(group, pos);
    const tipped = deepView() && group !== 'K' && group !== 'DEF';
    const cells = set.map(([k, lbl, tip]) => k == null ? h('td') : h('td', { class: 'lbl' }, h('span', tipped && k !== 'ros' ? tipAttrs(k, group === 'SKILL' ? 'WR' : pos) : { title: tip || null }, lbl)));
    while (cells.length < statN()) cells.push(h('td'));
    return h('tr', { class: 'typerow' }, h('td', { colspan: 4, class: 'fxsec' }), h('td'), ...cells, insightShown() ? h('td') : null);
}
// On another manager's roster the swap control has nothing to swap — it
// becomes the way to ask for that player instead.
function tradeIcon(R, pid) {
    if (!S.myRoster || !R || R.roster_id === S.myRoster.roster_id) return null;
    return h('span', { class: 'swap tr', title: `Propose a trade with ${teamName(R)} for ${pname(pid)}`, onclick: (ev) => { ev.stopPropagation(); openTrade(R.roster_id, pid); } }, '⇄');
}
// ── weeks ahead: the streaming planner ──────────────────────────────────────
// The Team page's second view. Rows for the positions people stream — DEF and
// K — over the next five weeks, shaded by how generous each opponent is to
// that position (loadDefRanks' table, which until now coloured exactly one
// superscript). The bottom row per position is the verdict: hold, or the best
// stream on the wire for a week the roster doesn't cover. Claim opens the
// composer, so this view and the market read share a doorway.
// Weeks ahead, above the roster. Folded, it is a sentence per streaming slot —
// who covers the next five weeks, where the hole or the soft stretch is, and
// the best stream when there is a hole. Open, it is the grid behind those
// sentences: DEF and K over the next five weeks, shaded by how generous each
// opponent is to that position (loadDefRanks), with the wire's best stream for
// any week the roster does not cover. Claim opens the composer.
function weeksAheadFold(my) {
    loadDefRanks();                                   // re-renders when it lands
    const weeks = []; for (let w = Math.max(1, S.curWeek); w <= Math.min(LAST_WEEK, Math.max(1, S.curWeek) + 4); w++) weeks.push(w);
    const rostered = rosteredSet();
    const posns = ['DEF', 'K'].filter(p => starterSlots().includes(p));
    if (!posns.length) return null;
    const wire = (pos) => Object.keys(S.players || {}).filter(pid => {
        const p2 = S.players[pid];
        return p2 && p2.position === pos && (pos === 'DEF' ? /^[A-Z]{2,3}$/.test(pid) : (p2.team && p2.status !== 'Inactive')) && !rostered.has(pid);
    });
    const rankOf = (pid, w) => { const i = oppRankInfo(pid, w); return i ? i.rank : null; };
    const cell = (pid, w) => {
        if (isBye(pid, w)) return h('div', { class: 'wkcell bye' }, h('b', { class: 'dim', style: 'text-decoration:line-through' }, 'BYE'));
        const opp = oppOf(pid, w); const rk = rankOf(pid, w);
        const tone = rk == null ? '' : rk >= 25 ? 'good' : rk <= 8 ? 'tough' : '';
        return h('div', { class: `wkcell ${tone}` }, h('b', null, opp || '—'),
            rk != null ? h('div', { class: 'mono dim', style: 'font-size:10px' }, `${ordinal(rk)}${rk >= 17 ? '-most' : ''} to ${pid && ppos(pid) === 'DEF' ? 'D/ST' : ppos(pid)}s`) : h('div', { class: 'mono dim', style: 'font-size:10px' }, ' '));
    };
    const facts = [];
    const grid = h('div', { class: 'wkgrid', style: `grid-template-columns:170px repeat(${weeks.length},1fr)` });
    grid.append(h('div'), ...weeks.map(w => h('div', { class: 'muted', style: 'text-align:center;font-size:10.5px;letter-spacing:.05em' }, `WK ${w}${w === S.curWeek ? ' · now' : ''}`)));
    const problems = [];
    for (const pos of posns) {
        const bodies = (my.players || []).filter(p => ppos(p) === pos);
        if (bodies.length) for (const pid of bodies) {
            grid.append(h('div', { style: 'display:flex;align-items:center;gap:7px' }, h('span', { class: `pos ${pos}`, style: 'font-size:9px;min-width:26px;height:16px' }, posLabel(pos)), h('b', { style: 'font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer', onclick: () => { S.ui.sel = pid; render(); } }, pname(pid))),
                ...weeks.map(w => cell(pid, w)));
        } else grid.append(h('div', { style: 'display:flex;align-items:center;gap:7px' }, h('span', { class: `pos ${pos}`, style: 'font-size:9px;min-width:26px;height:16px' }, posLabel(pos)), h('span', { class: 'dim', style: 'font-size:12px' }, 'none rostered')),
            ...weeks.map(() => h('div', { class: 'wkcell bye' }, h('b', { class: 'red', style: 'font-size:11px' }, 'empty'))));
        // The wire row: only weeks this position has NO playing body get a pick.
        const uncovered = weeks.filter(w => !bodies.some(pid => !isBye(pid, w)));
        const fact = { pos, bodies, uncovered, best: {} };
        facts.push(fact);
        if (uncovered.length) {
            const best = {}; const wpool = wire(pos);
            for (const w of uncovered) {
                let top = null, tv = -1;
                for (const pid of wpool) { if (isBye(pid, w)) continue; const rk = rankOf(pid, w) || 0; if (rk > tv) { tv = rk; top = pid; } }
                if (top) { best[w] = top; fact.best[w] = top; }
            }
            grid.append(h('div', { class: 'muted', style: 'font-size:10.5px;align-self:center' }, 'BEST ON THE WIRE'),
                ...weeks.map(w => {
                    const pid = best[w];
                    if (!pid) return h('div', { class: 'wkcell hold' }, h('span', { class: 'dim mono', style: 'font-size:10px' }, uncovered.includes(w) ? '—' : 'hold'));
                    return h('div', { class: 'wkcell pick', style: 'cursor:pointer', title: 'Open a claim', onclick: () => openComposer(pid, onWaiversNow(pid)) },
                        h('b', { class: 'amber', style: 'font-size:11px' }, pos === 'DEF' ? `${pid} D/ST` : (P(pid) || {}).last_name || pname(pid)),
                        h('div', { class: 'mono dim', style: 'font-size:10px' }, `${oppOf(pid, w) || ''} · ${rankOf(pid, w) ? ordinal(rankOf(pid, w)) : ''}`));
                }));
            const first = uncovered[0];
            if (best[first]) problems.push({ w: first, pos, pid: best[first] });
        } else grid.append(h('div', { class: 'muted', style: 'font-size:10.5px;align-self:center' }, 'BEST ON THE WIRE'),
            ...weeks.map(() => h('div', { class: 'wkcell hold' }, h('span', { class: 'dim mono', style: 'font-size:10px' }, 'hold'))));
    }
    // Your other starters' byes over the same weeks (a D/ST's or kicker's is in its own line, with the stream)
    const sByes = weeks.map(w => ({ w, who: starterSlots().map((sl, i) => (my.starters || [])[i]).filter(pid => pid && pid !== '0' && !posns.includes(ppos(pid)) && isBye(pid, w)) }));
    grid.append(h('div', { class: 'muted', style: 'font-size:10.5px;align-self:center' }, 'STARTERS ON BYE'),
        ...sByes.map(b => h('div', { class: `wkcell ${b.who.length ? 'bye' : 'hold'}` }, b.who.length ? h('b', { style: 'font-size:11px' }, b.who.map(p => (P(p) || {}).last_name || pname(p)).join(', ')) : h('span', { class: 'dim mono', style: 'font-size:10px' }, '—'))));
    // ── the folded sentences ──
    const nameOf = (pid, pos) => pos === 'DEF' ? `${pid} D/ST` : ((P(pid) || {}).last_name || pname(pid));
    const listW = (ws) => ws.length === 1 ? `week ${ws[0]}` : `weeks ${ws.slice(0, -1).join(', ')} and ${ws[ws.length - 1]}`;
    const streamTxt = (pid, w) => { const rk = rankOf(pid, w); return `${nameOf(pid, ppos(pid))} (${oppOf(pid, w) || ''}${rk ? ', ' + ordinal(rk) + (rk >= 17 ? '-most' : '') + ' to ' + (ppos(pid) === 'DEF' ? 'D/STs' : ppos(pid) + 's') : ''})`; };
    let tone = 'ok';
    const lines = facts.map(f => {
        const word = f.pos === 'DEF' ? 'D/ST' : 'kicker';
        const first = f.uncovered[0], bestFirst = first != null ? f.best[first] : null;
        if (!f.bodies.length) {
            tone = 'bad';
            return h('div', null, h('b', { class: 'red' }, `No ${word} on your roster.`), bestFirst ? ` Best stream for week ${first}: ${streamTxt(bestFirst, first)}.` : '');
        }
        const who = f.bodies.map(pid => nameOf(pid, f.pos)).join(' and ');
        if (f.uncovered.length) {
            if (tone !== 'bad') tone = first === weeks[0] ? 'bad' : 'warn';
            return h('div', null, h('b', null, who), ` is on bye in ${listW(f.uncovered)}`, bestFirst ? `; best stream then: ${streamTxt(bestFirst, first)}.` : '.');
        }
        const soft = weeks.filter(w => f.bodies.some(pid => (rankOf(pid, w) || 0) >= 25));
        const hard = weeks.filter(w => f.bodies.every(pid => { const rk = rankOf(pid, w); return rk != null && rk <= 8; }));
        return h('div', null, h('b', null, who), ' covers all five weeks',
            soft.length ? `, with soft matchups in ${listW(soft)}` : '',
            hard.length ? `${soft.length ? ' and' : ','} tough ones in ${listW(hard)}` : '', '.');
    });
    const byeTxt = sByes.filter(b => b.who.length).map(b => `${b.who.map(p => pname(p)).join(' and ')} in week ${b.w}`);
    if (byeTxt.length) lines.unshift(h('div', null, h('b', null, 'Byes: '), byeTxt.join('; '), '.'));
    let open = false; try { open = localStorage.getItem('badgerWeeksAhead') === 'open'; } catch (e) { /* closed */ }
    if (S.ui.weeksOpen != null) open = S.ui.weeksOpen;
    const flip = () => { S.ui.weeksOpen = !open; try { localStorage.setItem('badgerWeeksAhead', S.ui.weeksOpen ? 'open' : 'closed'); } catch (e) { /* session only */ } render(); };
    const card = h('div', { class: `card wafold ${tone}` },
        h('div', { class: 'wahead', onclick: flip, title: open ? 'Fold the grid' : 'Show the next five weeks' },
            h('span', { class: 'walab' }, 'Weeks ahead'),
            h('div', { class: 'wasum' }, ...lines),
            h('span', { class: 'lnk watog' }, open ? 'fold ' : 'next five weeks ', caret('', open))));
    if (!open) return card;
    card.append(h('div', { class: 'scroll-x', style: 'margin-top:10px' }, grid));
    const foot = h('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap' });
    for (const p of problems) foot.append(h('span', { class: 'chip amber' }, `Week ${p.w}: no ${p.pos === 'DEF' ? 'defence' : 'kicker'} — best stream is on the wire`),
        h('button', { class: 'btn sm warn', onclick: () => openComposer(p.pid, onWaiversNow(p.pid)) }, `Claim ${p.pos === 'DEF' ? p.pid + ' D/ST' : (P(p.pid) || {}).last_name || pname(p.pid)}`));
    if (!problems.length) foot.append(h('span', { class: 'chip green' }, 'Every week covered'));
    foot.append(h('span', { class: 'dim', style: 'font-size:11px;margin-left:auto' }, S.defRanks ? `shading = fantasy points allowed to that position, ${S.defRanksSeason} season` : 'ranking opponents…'));
    card.append(foot);
    return card;
}
function rosterCard(my, ro) {
    if (l4Basis()) wantL4();
    const slots = starterSlots();
    const reserve = my.reserve || [], taxi = my.taxi || [];
    const startersSet = new Set((my.starters || []).filter(p => p && p !== '0'));
    const byGroupOrder = ['SKILL', 'QB', 'K', 'DEF'];
    const benchSlots = rosterPositions().filter(p2 => p2 === 'BN').length;
    const openBench = Math.max(0, benchSlots - ((my.players || []).filter(p => !startersSet.has(p) && !reserve.includes(p) && !taxi.includes(p)).length));
    const bench = (my.players || []).filter(p => !startersSet.has(p) && !reserve.includes(p) && !taxi.includes(p))
        .sort((a, b) => (byGroupOrder.indexOf(groupOf(a)) - byGroupOrder.indexOf(groupOf(b))) || ((projOf(b, S.week) || 0) - (projOf(a, S.week) || 0)));
    const showIns = insightShown();
    const NCOLS = 5 + statN() + (showIns ? 1 : 0);   // slot · swap · player · opp · pts · the stats · insight, under Proj (Drop, Own% and St% live on the player card)
    // A signed figure to two places (+0.05) is the widest thing a number column holds, so those keep their width.
    const signedCol = (i) => {  return false; };
    // Insight is one line of words: where it shows, it gets the width a line needs and the numbers get the rest.
    // The table stops growing once a number column would pass 104px beside an Insight column, where a wider screen
    // only adds air. Where Insight is not shown the numbers take its room, so the table is as wide either way.
    const PTS_W = 96, deepT = statN() > STAT_N, wideT = statN() > USAGE_N, insRoom = !deepT ? 320 : wideT ? 174 : 180, insW = showIns ? insRoom : 0, statMin = !deepT ? 64 : wideT ? 54 : 56, LEAD_W = 452 + PTS_W;
    const INS = insightsIndex(my);
    const insightTd = (ref) => showIns ? insightCell(INS, ref) : null;
    const posMark = (pid) => { const p = ppos(pid); return h('span', { class: `pos txt ${p}`, style: 'margin-right:5px' }, posLabel(p)); };
    const colgroup = h('colgroup', null,
        h('col', { style: 'width:56px' }), h('col', { style: 'width:30px' }), h('col', { style: 'width:280px' }), h('col', { style: 'width:86px' }), h('col', { style: `width:${PTS_W}px` }),
        ...Array.from({ length: statN() }, (_, i) => h('col', { style: signedCol(i) ? 'width:62px' : null })),   /* the numbers share what is left */
        showIns ? h('col', { style: `width:${insW}px` }) : null);
    const fx = (el, cls) => { el.classList.add('fxc', cls); return el; };
    // the deep views are as wide as their columns, so ten fit a laptop without scrolling sideways
    const tbl = h('table', { class: 'fixedcols', style: `min-width:${LEAD_W + statN() * statMin + insW}px;max-width:${LEAD_W + statN() * 104 + insRoom}px` }, colgroup, h('tr', null, fx(h('th', null, 'Slot'), 'fx1'), fx(h('th', { class: 'swcol' }, ''), 'fx2'), fx(h('th', null, 'Player'), 'fx3'), fx(h('th', null, 'Opp'), 'fx4'),
        h('th', { class: 'r', title: (S.ui.basis === 'wkActual' || S.ui.basis === 'usage') ? `Week ${S.week} points` : S.ui.basis === 'wkProj' ? `Week ${S.week} projection` : l4Basis() ? 'Points per game, last four games played' : (S.ui.basis === 'seasActual' || S.ui.basis === 'usageS') ? 'Season points to date' : 'Rest of season, projected' }, (S.ui.basis === 'wkActual' || S.ui.basis === 'usage') ? 'Pts' : S.ui.basis === 'wkProj' ? 'Proj' : l4Basis() ? 'Pts/G' : (S.ui.basis === 'seasActual' || S.ui.basis === 'usageS') ? 'Pts' : 'ROS'),
        h('th', { class: 'r', colspan: statN() }, isUsage(S.ui.basis) ? `Usage · ${S.ui.basis === 'usage' ? 'wk ' + S.week : S.ui.basis === 'usageL4' ? 'last 4 games' : 'season'}` : 'Stats · ' + (S.ui.basis === 'l4Actual' ? 'last 4 games' : S.ui.basis === 'wkActual' ? 'wk actual' : S.ui.basis === 'wkProj' ? 'wk proj' : S.ui.basis === 'seasActual' ? 'season' : 'ROS')),
        showIns ? h('th', null, '\u{1F9A1} Insight') : null));
    const commonCells = (pid) => {
        const line = statLine(pid, S.ui.basis); const l4 = l4Basis(); const seas = !l4 && (S.ui.basis === 'seasActual' || S.ui.basis === 'ros' || S.ui.basis === 'usageS');
        // over the last four, points per game — with the game count when he has fewer than four
        const ptsCell = !line || line.pts == null ? h('span', { class: 'dim' }, '—') : l4 ? [fmt1(line.pts / (line.gp || 1)), l4Short(line) ? h('span', { class: 'was' }, `${line.gp} g`) : null] : seas ? fmt0(line.pts) : (S.ui.basis === 'wkActual' || S.ui.basis === 'usage') ? fmtS(line.pts) : fmt1(line.pts);
        const rk = line && line.pts != null ? ranksFor(S.ui.basis).pos[pid] : null;
        return [
            fx(oppCell(pid, S.week), 'fx4'),
            h('td', { class: 'r mono', style: 'font-weight:600' }, rk ? h('span', { class: 'rki', title: `${ordinal(rk)} ${posLabel(ppos(pid))} by this column` }, `${posLabel(ppos(pid))}${rk}`) : null, ptsCell),
        ];
    };
    // ── starters, strip when the group changes ──
    let lastGroup = null;
    slots.forEach((sl, i) => {
        const pid = (my.starters || [])[i]; const empty = !pid || pid === '0';
        const slotGroup = FLEX[sl] ? (empty ? 'SKILL' : groupOf(pid)) : (GROUPS[sl] || (empty ? 'SKILL' : groupOf(pid)));
        const slotPos = empty ? (FLEX[sl] ? 'WR' : sl) : ppos(pid);
        const stripKey = stripKeyOf(slotGroup, slotPos);
        if (stripKey !== lastGroup) { tbl.append(stripRow(slotGroup, slotPos)); lastGroup = stripKey; }
        // Once his game has kicked off the slot is locked for the week: Sleeper refuses the move, so the
        // row offers none. It is not a swap target and its button is off. And an OUT on a man who has
        // already played is an injury in the game, not a row asking to be fixed.
        const locked = !ro && !empty && muLocked(pid);
        const bad = !empty && (isBye(pid, S.week) || (/out|ir|pup|sus/i.test(statusOf(pid) || '') && !playedWeek(pid, S.week)));
        const sw = (ro ? null : S.ui.swapFrom);
        const swapping = sw && !sw.type && sw.i === i;
        const irTake = !locked && sw && sw.type === 'ir' && slotEligible(sl, sw.pid);
        const benchTake = !locked && sw && sw.type === 'bench' && !muLocked(sw.pid) && slotEligible(sl, sw.pid);
        const mutual = !locked && sw && !sw.type && !swapping && !empty && slotEligible(sw.slot, pid) && (!sw.pid || slotEligible(sl, sw.pid));
        const takeFn = irTake ? (() => activateInto(sw.pid, i, empty ? null : pid)) : benchTake ? (() => doSwap({ i, slot: sl, pid: empty ? null : pid }, sw.pid)) : mutual ? (() => doStarterExchange(sw, i)) : null;
        const takeTip = irTake ? `Activate ${pname(sw.pid)} straight into ${FLEX[sl] ? 'FLEX' : sl}` : benchTake ? `${pname(sw.pid)} starts at ${FLEX[sl] ? 'FLEX' : sl}${empty ? '' : '; ' + pname(pid) + ' to the bench'}` : mutual ? `Move ${pname(pid)} to ${FLEX[sw.slot] ? 'FLEX' : sw.slot}${sw.pid ? ' and ' + pname(sw.pid) + ' here' : ''}` : null;
        tbl.append(h('tr', { class: takeFn ? 'cantake' : sw && !swapping ? 'fade' : bad || empty ? 'bad' : swapping ? 'pick' : '', title: takeTip, onclick: takeFn, 'data-where': 'starter', 'data-slot': i, 'data-pid': empty ? '0' : pid },
            fx(h('td', null, slotChip(sl, null, empty ? [] : [pid])), 'fx1'),
            fx(h('td', { class: 'swcol' }, (() => {
                if (takeFn) return h('span', { class: 'swap go', title: takeTip }, '⇅');
                if (ro) return empty ? null : tradeIcon(my, pid);
                if (locked) return h('span', { class: 'swap lock', 'aria-disabled': 'true', title: `${pname(pid)}’s game has kicked off: this slot is locked for the week` }, '⇅');
                const irOk = !empty && irEligible(pid);
                return h('span', { class: `swap ${swapping ? 'on' : irOk ? 'ir' : bad || empty ? 'hot' : ''}`, title: swapping ? 'Cancel' : irOk ? 'IR-eligible — swap him, or place him in an empty IR slot below' : empty ? 'Swap: pick a bench player or another starter' : 'Swap: pick a bench player or another starter. Or pick the Bench header to bench him and leave the slot empty', onclick: (ev) => { ev.stopPropagation(); if (sw && !swapping) return; S.ui.swapFrom = swapping ? null : { i, slot: sl, pid: empty ? null : pid }; render(); } }, '⇅');
            })()), 'fx2'),
            // An empty slot's insight ("no kicker — best FA: …") lives beside the
            // chip, in the 280px player cell that is otherwise blank; in the
            // insight column it was clamped to "no kicker — best F…".
            fx(h('td', null, empty ? h('div', { class: 'rsempty' }, h('span', { class: 'chip red' }, 'Empty slot'), (() => { const ins = INS['slot:' + i]; return ins ? h('span', { class: 'rsetxt', title: ins.text }, ins.text.replace(/^no [\w/ ]+ \u2014 /, '')) : null; })()) : playerCell(pid, S.week, { nick: true })), 'fx3'),
            ...(empty ? [fx(h('td', null), 'fx4'), h('td', { class: 'r mono red' }, '—')] : commonCells(pid)),
            ...(empty ? [h('td', { colspan: statN() })] : groupStatCells(pid, slotGroup)),
            empty ? (showIns ? h('td', { class: 'inscol' }) : null) : insightTd(pid)));
    });
    // ── bench ──
    {
        const swb = (ro ? null : S.ui.swapFrom);
        if (swb && swb.type === 'ir') {
            const row = h('tr', { class: 'secrow cantake', title: `Activate ${pname(swb.pid)} to the bench` }, h('td', { colspan: 4, class: 'fxsec' }, h('b', null, 'Bench'), h('span', { class: 'dim', style: 'margin-left:10px;font-size:11px;font-weight:600' }, `← click to activate ${pname(swb.pid)} to the bench`)), h('td', { colspan: NCOLS - 4 }));
            row.addEventListener('click', () => { S.ui.swapFrom = null; act(() => setReserve((my.reserve || []).filter(x => x !== swb.pid)), `${pname(swb.pid)} activated`); });
            tbl.append(row);
        } else if (swb && !swb.type && swb.pid) {
            // a starter is picked: the header takes him with nobody coming in, and the slot is left empty
            const slot = FLEX[swb.slot] ? 'FLEX' : swb.slot;
            const row = h('tr', { class: 'secrow cantake', 'data-act': 'bench-out', title: `Bench ${pname(swb.pid)} and leave ${slot} empty` }, h('td', { colspan: 4, class: 'fxsec' }, h('b', null, 'Bench'), h('span', { class: 'dim', style: 'margin-left:10px;font-size:11px;font-weight:600' }, `← click to bench ${shortName(swb.pid)}, ${slot} left empty`)), h('td', { colspan: NCOLS - 4 }));
            row.addEventListener('click', () => doBench(swb));
            tbl.append(row);
        } else tbl.append(h('tr', { class: 'secrow' }, h('td', { colspan: 4, class: 'fxsec' }, h('b', null, 'Bench'), h('span', { class: 'dim', style: 'margin-left:10px;font-size:11px;font-weight:600' }, swb && swb.type === 'bench' ? `Placing ${pname(swb.pid)} — pick the slot above` : swb ? 'Pick the player for that slot' : `${bench.length} of ${benchSlots} used · grouped by type, best first`)), h('td', { colspan: NCOLS - 4 })));
    }
    lastGroup = null;
    for (const pid of bench) {
        const g = groupOf(pid);
        const gk = stripKeyOf(g, ppos(pid));
        if (gk !== lastGroup) { tbl.append(stripRow(g, ppos(pid))); lastGroup = gk; }
        const sw = (ro ? null : S.ui.swapFrom);
        const playedB = !ro && muLocked(pid);   // his game has kicked off: he cannot come into the lineup this week
        const lockedB = playedB && !irEligible(pid);   // (an IR-eligible one keeps his button: it is how he is placed on IR)
        const canReceive = !playedB && sw && !sw.type && slotEligible(sw.slot, pid);
        const selected = sw && sw.type === 'bench' && sw.pid === pid;
        const takeTip2 = canReceive ? `${pname(pid)} starts at ${FLEX[sw.slot] ? 'FLEX' : sw.slot}${sw.pid ? '; ' + pname(sw.pid) + ' to the bench' : ''}` : null;
        tbl.append(h('tr', { class: canReceive ? 'cantake' : selected ? 'pick' : sw && !selected ? 'fade' : '', title: takeTip2, onclick: canReceive ? (() => doSwap(sw, pid)) : null, 'data-where': 'bench', 'data-pid': pid },
            fx(h('td', null, h('span', { class: 'pos BN' }, 'BN')), 'fx1'),
            fx(h('td', { class: 'swcol' }, ro ? tradeIcon(my, pid) : canReceive ? h('span', { class: 'swap go', title: takeTip2 }, '⇅')
                : lockedB ? h('span', { class: 'swap lock', 'aria-disabled': 'true', title: `${pname(pid)}’s game has kicked off: he cannot be started this week` }, '⇅')
                : h('span', { class: `swap ${selected ? 'on' : irEligible(pid) ? 'ir' : ''}`, title: selected ? 'Cancel' : irEligible(pid) ? 'IR-eligible — swap him, or place him in an empty IR slot below' : 'Swap: pick the starting slot for him above', onclick: (ev) => { ev.stopPropagation(); if (sw && !selected) return; S.ui.swapFrom = selected ? null : { type: 'bench', pid }; render(); } }, '⇅')), 'fx2'),
            fx(h('td', null, benchPlayerCell(pid, null)), 'fx3'),
            ...commonCells(pid),
            ...groupStatCells(pid, g),
            insightTd(pid)));
    }
    // A bench spot you are not using is a free pickup: nobody has to be dropped.
    // With a starter picked, an open spot takes him the same way the Bench header does.
    const swo = (ro ? null : S.ui.swapFrom), benchOut = swo && !swo.type && swo.pid ? swo : null;
    for (let n = 0; n < openBench; n++) tbl.append(h('tr', { class: benchOut ? 'openrow cantake' : 'openrow', title: benchOut ? `Bench ${pname(benchOut.pid)} and leave ${FLEX[benchOut.slot] ? 'FLEX' : benchOut.slot} empty` : 'Nobody has to be dropped to fill it', onclick: benchOut ? (() => doBench(benchOut)) : null },
        fx(h('td', null, h('span', { class: 'pos BN open' }, 'BN')), 'fx1'), fx(h('td', { class: 'swcol' }, benchOut ? h('span', { class: 'swap go' }, '⇅') : null), 'fx2'),
        fx(h('td', null, h('div', { class: 'openbn' }, h('b', null, 'Open bench spot'),
            benchOut ? (n === 0 ? h('span', { class: 'dim', style: 'font-size:11.5px' }, `← bench ${shortName(benchOut.pid)} here`) : null)
                : ro ? null : h('button', { class: 'btn sm s', onclick: () => go('players', { playersTab: 'available' }) }, 'Find a player →'))), 'fx3'),
        h('td', { colspan: NCOLS - 3 }, n === 0 && !benchOut ? h('span', { class: 'dim', style: 'font-size:11.5px' }, openBench > 1 ? `${openBench} spots open — nobody has to be dropped to fill them` : 'nobody has to be dropped — a pickup costs you the claim and nothing else') : null)));
    if (!bench.length && !openBench) tbl.append(h('tr', null, h('td', { colspan: NCOLS, class: 'empty' }, 'Everyone is starting.')));
    // ── IR ──
    const irSlots = (S.league.settings || {}).reserve_slots || 0;
    if (irSlots || reserve.length) tbl.append(h('tr', { class: 'secrow' }, h('td', { colspan: 4, class: 'fxsec' }, h('b', null, 'IR'), h('span', { class: 'dim', style: 'margin-left:10px;font-size:11px;font-weight:600' }, `${reserve.length} of ${irSlots} used`)), h('td', { colspan: NCOLS - 4 })));
    lastGroup = null;
    for (const pid of reserve) {
        const g = groupOf(pid);
        const gk = stripKeyOf(g, ppos(pid));
        if (gk !== lastGroup) { tbl.append(stripRow(g, ppos(pid))); lastGroup = gk; }
        const sw = (ro ? null : S.ui.swapFrom);
        const selIR = sw && sw.type === 'ir' && sw.pid === pid;
        tbl.append(h('tr', { class: selIR ? 'pick' : sw && !selIR ? 'fade' : '', 'data-where': 'ir', 'data-pid': pid }, fx(h('td', null, h('span', { class: 'pos IR' }, 'IR')), 'fx1'),
            fx(h('td', { class: 'swcol' }, ro ? tradeIcon(my, pid) : h('span', { class: `swap ${selIR ? 'on' : ''}`, title: selIR ? 'Cancel' : 'Activate: pick a starting slot above, or the Bench header', onclick: (ev) => { ev.stopPropagation(); if (sw && !selIR) return; S.ui.swapFrom = selIR ? null : { type: 'ir', pid }; render(); } }, '⇅')), 'fx2'),
            fx(h('td', null, benchPlayerCell(pid, null)), 'fx3'), ...commonCells(pid), ...groupStatCells(pid, g), insightTd(pid)));
    }
    for (let i = reserve.length; i < irSlots; i++) {
        const sw = (ro ? null : S.ui.swapFrom); const swPid = sw && sw.pid;
        const canIR = swPid && irEligible(swPid);
        tbl.append(h('tr', { class: canIR ? 'cantake' : sw ? 'fade' : '', title: canIR ? `Move ${pname(swPid)} to IR` : null, onclick: canIR ? (() => moveToIR(sw)) : null }, h('td', null, h('span', { class: 'pos IR' }, 'IR')),
            h('td', { class: 'swcol' }, canIR ? h('span', { class: 'swap go' }, '⇅') : null),
            h('td', { colspan: NCOLS - 2, class: 'dim', style: 'font-size:12px' }, canIR ? `Open IR slot for ${pname(swPid)}` : ro ? 'Empty' : 'Empty — a red ⇅ marks IR-eligible players (OUT, IR, PUP…); select one and place him here')));
    }
    for (const pid of taxi) tbl.append(h('tr', null, fx(h('td', null, h('span', { class: 'pos TAXI' }, 'TAXI')), 'fx1'), fx(h('td', { class: 'swcol' }), 'fx2'), fx(h('td', null, benchPlayerCell(pid, null)), 'fx3'), ...commonCells(pid), ...groupStatCells(pid, groupOf(pid)), insightTd(pid)));
    const foot = deepView() ? h('div', { class: 'gloss' },
        levelKey(), h('span', null, 'He is ranked among the players at his position on the field for a quarter of their team’s snaps, over the same games. A rate is ranked only with enough work behind it; with too little it is drawn dim.'),
        S.ui.basis === 'usageS' ? h('span', null, h('span', { class: 'trend up' }, '\u25b2'), h('span', { class: 'trend down' }, '\u25bc'), ' his last four games against his season; no mark is steady.') : null,
        h('span', null, `${isUsage(S.ui.basis) ? 'ROS is Sleeper’s rest-of-season projection, drawn the same way. ' : ''}Hover a column header for what it is and how this season’s players at the position compare.`)) : null;
    return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, ro ? `${teamName(my)} — roster` : 'Roster'), periodCluster({ team: true })), h('div', { class: 'scroll-x' }, tbl), foot);
}
// Every row leads with the position now, so this only adds the bench note.
function benchPlayerCell(pid, beat) {
    const cell = playerCell(pid, S.week, { nick: true });
    if (beat) { const sub = cell.querySelector('.sub'); if (sub) sub.append(h('span', { class: 'grn' }, `  ${beat}`)); }
    return cell;
}
// Whether a status may sit on IR at all, by this league's settings. Asked two
// ways: of a bench player (may he go on?) and of a reserve player (may he stay
// there?) — Sleeper blocks every roster move while someone who has healed is
// still on IR, so the second question is a red to-do, not a nicety.
function irStatusOk(pid) {
    const s = (statusOf(pid) || '').toLowerCase(), st = S.league.settings || {};
    return s === 'ir' || (s === 'out' && st.reserve_allow_out) || (s === 'pup') || (s === 'sus' && st.reserve_allow_sus) || (s === 'na' && st.reserve_allow_na) || (s === 'doubtful' && st.reserve_allow_doubtful) || (s === 'cov' && st.reserve_allow_cov) || (s === 'dnr' && st.reserve_allow_dnr);
}
function irEligible(pid) { const st = S.league.settings || {}; if (!(st.reserve_slots > 0)) return false;   // IR capacity lives in settings, not roster_positions
    if ((S.myRoster.reserve || []).length >= st.reserve_slots) return false; return irStatusOk(pid); }
async function doSwap(from, benchPid) {
    const st = (S.myRoster.starters || []).slice();
    const j = st.indexOf(benchPid);
    st[from.i] = benchPid;
    if (j >= 0) st[j] = from.pid || '0';
    S.ui.swapFrom = null;
    await act(() => setStarters(st), `${pname(benchPid)} starts at ${FLEX[from.slot] ? 'FLEX' : from.slot}`);
}
// A starter to the bench with nobody coming in. The slot is left empty ('0' is
// how Sleeper holds one), to be filled later or not at all.
async function doBench(from) {
    const st = (S.myRoster.starters || []).slice();
    st[from.i] = '0';
    S.ui.swapFrom = null;
    await act(() => setStarters(st), `${pname(from.pid)} to the bench, ${FLEX[from.slot] ? 'FLEX' : from.slot} left empty`);
}
async function doStarterExchange(from, j) {
    const st = (S.myRoster.starters || []).slice();
    const other = st[j];
    st[from.i] = other;
    st[j] = from.pid || '0';
    S.ui.swapFrom = null;
    await act(() => setStarters(st), `${pname(other)} to ${FLEX[from.slot] ? 'FLEX' : from.slot}${from.pid ? ', ' + pname(from.pid) + ' to ' + (FLEX[starterSlots()[j]] ? 'FLEX' : starterSlots()[j]) : ''}`);
}
async function activateInto(pid, slotIdx, displaced) {
    S.ui.swapFrom = null;
    await act(async () => {
        await setReserve((S.myRoster.reserve || []).filter(x => x !== pid));
        const st = (S.myRoster.starters || []).slice();
        st[slotIdx] = pid;
        await setStarters(st);
    }, `${pname(pid)} activated${displaced ? ', ' + pname(displaced) + ' to the bench' : ''} — starting`);
}
async function moveToIR(sw) {
    const pid = sw.type === 'bench' ? sw.pid : sw.pid;
    S.ui.swapFrom = null;
    await act(async () => {
        if (!sw.type) { const st = (S.myRoster.starters || []).slice(); st[sw.i] = '0'; await setStarters(st); }
        await setReserve([...(S.myRoster.reserve || []), pid]);
    }, `${pname(pid)} moved to IR`);
}
function confirmDrop(pid) {
    if (!confirm(`Drop ${pname(pid)}? This is immediate.`)) return;
    act(() => addDrop({}, { [pid]: S.myRoster.roster_id }), `${pname(pid)} dropped`);
}

// ── Players ──────────────────────────────────────────────────────────────────
// Which stat lines matter, per position, for the table's numeric block.
const STAT_COLS = {
    ALL: [['pass_yd', 'PA YD'], ['pass_td', 'PA TD'], ['rec', 'REC'], ['rec_yd', 'RE YD'], ['rec_td', 'RE TD'], ['rush_yd', 'RU YD'], ['rush_td', 'RU TD']],
    QB: GROUP_STATS.QB, RB: [...BOX_RUSH, ...BOX_REC],   // a back's own tab leads with the ground game
    WR: BOX_REC, TE: BOX_REC, FLEX: GROUP_STATS.SKILL, K: GROUP_STATS.K, DEF: GROUP_STATS.DEF,
};
// Periods. Weekly: the week in the top bar, actual if it has been played,
// projected if it has not, both when it is the current week. Season: to date,
// the full-season projection, or the rest of the season summed from Sleeper's
// remaining weekly projections.
const LAST_WEEK = 18;
function periodsFor(opts) {
    const w = S.week, played = S.seasonType === 'regular' && w <= S.curWeek && (S.stats[w] && Object.keys(S.stats[w]).length);
    const canActual = S.seasonType === 'regular' && w <= S.curWeek, inSeason = S.seasonType === 'regular';
    const weekly = [['wkProj', 'Proj', `Sleeper's projection for week ${w}`, true],
        ['wkActual', 'Actual', canActual ? (played ? `Week ${w} results` : `Week ${w} — no stats yet`) : `Week ${w} has not been played`, canActual],
        ['usage', 'Usage', canActual ? `How he was used in week ${w}: snaps, shares, red zone` : `Week ${w} has not been played`, canActual]];
    const season = [['ros', 'Proj', `Rest of season: weeks ${Math.max(1, S.curWeek)}–${LAST_WEEK} projected and summed`, true],
        ['seasActual', 'Actual', 'Season to date, with games played and per-game average', true],
        ['usageS', 'Usage', 'How he has been used this season: snaps, shares, red zone — counts per game', true]];
    // The last four games each player played: a box score per game, or usage. A
    // projection has no last four, so Proj sits dimmed rather than disappearing —
    // the tabs never move.
    const last4 = [['wkProj', 'Proj', `A projection has no last four games \u2014 this goes back to week ${w}'s`, false, 'weekly'],
        ['l4Actual', 'Actual', 'His last four games played: the box score per game', inSeason],
        ['usageL4', 'Usage', 'His last four games played: shares, and counts per game', inSeason]];

    return { weekly, season, last4 };
}
// Changing the period keeps the lens: Usage over a week becomes Usage over the
// season, not whatever happens to be first in the new list.
function settleBasis(per) {
    const ui = S.ui, list = per[ui.scope] || per.weekly;
    if (list.some(([k, , , ok]) => k === ui.basis && ok !== false)) return list;
    const was = [...per.weekly, ...per.season, ...per.last4].find(([k]) => k === ui.basis);
    const same = was && list.find(([, t, , ok]) => t === was[1] && ok !== false);
    ui.basis = (same || list.find(([, , , ok]) => ok !== false) || list[0])[0];
    return list;
}

async function loadRos() {
    const from = Math.max(1, S.curWeek);
    if (S.ros && S.rosFrom === from) return;
    const weeks = []; for (let w = from; w <= LAST_WEEK; w++) weeks.push(w);
    await Promise.all(weeks.map(w => loadProj(w)));
    const m = {};
    for (const w of weeks) for (const [pid, x] of Object.entries(S.proj[w] || {})) { if (x.pts == null) continue; const e = m[pid] = m[pid] || { pts: 0, gp: 0, stats: {} }; e.pts += x.pts; e.gp += 1; for (const [k, v] of Object.entries(x.stats || {})) if (typeof v === 'number') e.stats[k] = (e.stats[k] || 0) + v; }
    S.ros = m; S.rosFrom = from;
}
function statLine(pid, basis) {
    if (basis === 'wkProj') return (S.proj[S.week] || {})[pid] || null;
    if (basis === 'wkActual' || basis === 'usage') return (S.stats[S.week] || {})[pid] || null;
    if (basis === 'usageS') return (S.seasonStats || {})[pid] || null;
    if (basis === 'usageL4' || basis === 'l4Actual') return (l4Pool() || {})[pid] || null;

    if (basis === 'seasProj') return (S.seasonProj || {})[pid] || null;
    if (basis === 'ros') return (S.ros || {})[pid] || null;
    return (S.seasonStats || {})[pid] || null;
}
function basisPool(basis) { return basis === 'wkProj' ? S.proj[S.week] : (basis === 'wkActual' || basis === 'usage') ? S.stats[S.week] : basis === 'seasProj' ? S.seasonProj : basis === 'ros' ? S.ros : (basis === 'usageL4' || basis === 'l4Actual') ? l4Pool() : S.seasonStats; }
// Overall and positional rank by points, per basis, over everyone with a line.
const rankCache = {};
let statsGen = 0;   // bumped whenever live stats are re-pulled — see refreshLive()
function ranksFor(basis) {
    const pool = basisPool(basis) || {};
    const key = basis + ':' + (basis.startsWith('wk') ? S.week : basis === 'usageL4' || basis === 'l4Actual' ? l4End() + S.ui.scope : '') + ':' + Object.keys(pool).length + ':' + statsGen;
    if (rankCache[key]) return rankCache[key];
    const per = basis === 'usageL4' || basis === 'l4Actual' ? (x) => x.pts / (x.gp || 1) : (x) => x.pts;
    const rows = Object.entries(pool).filter(([pid, x]) => x && x.pts != null && P(pid) && POS_ORDER.includes(ppos(pid))).sort((a, b) => per(b[1]) - per(a[1]));
    const overall = {}, pos = {}, cnt = {};
    rows.forEach(([pid], i) => { overall[pid] = i + 1; const p = ppos(pid); cnt[p] = (cnt[p] || 0) + 1; pos[pid] = cnt[p]; });
    return (rankCache[key] = { overall, pos });
}
// The same ranking over any pool of scored lines — another week's projections,
// a week's results, a rest-of-season sum — remembered against the pool itself.
const poolRankMemo = new WeakMap();
function poolRanks(pool) {
    if (!pool) return null;
    const hit = poolRankMemo.get(pool);
    if (hit && hit.gen === statsGen) return hit.r;
    const rows = Object.entries(pool).filter(([pid, x]) => x && x.pts != null && P(pid) && POS_ORDER.includes(ppos(pid))).sort((a, b) => b[1].pts - a[1].pts);
    const overall = {}, pos = {}, n = {};
    rows.forEach(([pid], i) => { overall[pid] = i + 1; const p = ppos(pid); n[p] = (n[p] || 0) + 1; pos[pid] = n[p]; });
    const r = { overall, pos, n };
    poolRankMemo.set(pool, { gen: statsGen, r });
    return r;
}
// Where he finished at his position in a week already played. A week whose
// stats are in hand (this week, the last four) is ranked from them. An older
// one is fetched once, ranked, and only the ranks are kept — in this browser
// too, because a finished week never changes — so a card's timeline costs one
// request per old week the first time and none after. They go one at a time,
// and the same fetch keeps each team's totals for the usage shares.
// A number is his rank, null is no rank that week, undefined is still loading.
const scoreSig = () => { const t = JSON.stringify((S.league && S.league.scoring_settings) || {}); let x = 0; for (let i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) | 0; return String(x); };
const wkRankKey = () => `badgerWkRank:${S.leagueId}`;
const WK_TEAM_KEY = 'badgerWkTeam';   // each team's targets, carries and air yards by week: the same in every league
let wkRankChain = Promise.resolve();
function wkRankStore() {
    return (S.wkRankP = S.wkRankP || (async () => {
        let saved = null; try { saved = (await chrome.storage.local.get(wkRankKey()))[wkRankKey()]; } catch (e) { /* no storage: this visit only */ }
        S.wkRank = saved && saved.season === S.season && saved.sig === scoreSig() && saved.weeks ? saved.weeks : {};
        return S.wkRank;
    })());
}
function wkTeamStore() {
    return (S.wkTeamP = S.wkTeamP || (async () => {
        let saved = null; try { saved = (await chrome.storage.local.get(WK_TEAM_KEY))[WK_TEAM_KEY]; } catch (e) { /* no storage: this visit only */ }
        S.wkTeam = saved && saved.season === S.season && saved.weeks ? saved.weeks : {};
        return S.wkTeam;
    })());
}
function loadWeekFacts(w) {
    return once(`wkfacts:${w}`, () => (wkRankChain = wkRankChain.then(async () => {
        const [ranks, teams] = await Promise.all([wkRankStore(), wkTeamStore()]);
        if (S.stats[w] || (ranks[w] && teams[w])) return;
        const url = `${API2}/stats/nfl/${S.season}/${w}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=pts_half_ppr`;
        let list; try { list = await rest(url); } catch (e) { (S.wkRankFail = S.wkRankFail || {})[w] = Date.now(); return; }
        const pool = {}; for (const x of list) pool[x.player_id] = { pts: scoreStats(x.stats), stats: x.stats };
        ranks[w] = poolRanks(pool).pos;
        teams[w] = Object.fromEntries(Object.entries(teamTotals(pool)).map(([t, e]) => [t, [e.tgt, e.car, e.air]]));
        if (w < S.curWeek) { const done = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => Number(k) < S.curWeek));
            try { await chrome.storage.local.set({ [wkRankKey()]: { season: S.season, sig: scoreSig(), weeks: done(ranks) }, [WK_TEAM_KEY]: { season: S.season, weeks: done(teams) } }); } catch (e) { /* kept for this visit */ } }
    }).catch(() => {})));
}
// A team's targets, carries and air yards in a week, for a share of them: from
// the week's stats when they are in hand, else from the saved totals. null is
// no such team that week, undefined is still loading.
function weekTeamTotals(w, team) {
    if (S.stats[w]) return teamTotals(S.stats[w])[team] || null;
    const t = S.wkTeam && S.wkTeam[w];
    if (t) { const a = t[team]; return a ? { tgt: a[0], car: a[1], air: a[2] } : null; }
    if (S.wkRankFail && Date.now() - (S.wkRankFail[w] || 0) < 60000) return null;
    loadWeekFacts(w).then(render);
    return undefined;
}
function weekPosRank(pid, w) {
    if (S.stats[w]) return poolRanks(S.stats[w]).pos[pid] || null;
    if (S.wkRank && S.wkRank[w]) return S.wkRank[w][pid] || null;
    if (S.wkRankFail && Date.now() - (S.wkRankFail[w] || 0) < 60000) return null;
    loadWeekFacts(w).then(render);
    return undefined;
}

// ── Sleeper's season ADP, for the quick views ───────────────────────────────
// "Drafted outside the top 30 at his position" is judged on Sleeper's own
// half-PPR ADP, read from the season projections endpoint and turned into a
// rank at each position. A day's cache.
async function loadSleeperAdp() {
    if (S.sleeperAdp) return;
    const KEY = 'badgerSleeperAdp';
    let st = null; try { st = (await chrome.storage.local.get(KEY))[KEY]; } catch (e) { /* no storage */ }
    if (!st || st.season !== String(S.season) || Date.now() - (st.at || 0) > 24 * 3600e3) {
        try {
            const rows = await rest(`${API2}/projections/nfl/${S.season}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=adp_half_ppr`);
            const byPos = {};
            for (const r of rows || []) { const pos = r.player && r.player.position, v = r.stats && r.stats.adp_half_ppr; if (!pos || v == null || v <= 0 || v >= 999) continue; (byPos[pos] = byPos[pos] || []).push([String(r.player_id), v]); }
            const adp = {}; for (const arr of Object.values(byPos)) { arr.sort((x, y) => x[1] - y[1]); arr.forEach(([sid], i) => { adp[sid] = i + 1; }); }
            st = { season: String(S.season), at: Date.now(), adp };
            try { await chrome.storage.local.set({ [KEY]: st }); } catch (e) { /* best effort */ }
        } catch (e) { console.warn(TAG, 'sleeper adp:', e.message); return; }
    }
    S.sleeperAdp = st.adp || {}; S.sleeperAdpFresh = true;
}

// ── last four games, from Sleeper's own weekly pulls ─────────────────────────
// A player's last four games PLAYED, reaching back six weeks so a bye and one
// missed game do not thin it. Counts are summed; Sleeper's per-game rates
// (ypa, rating, cmp%) cannot be, so they are dropped and recomputed from the
// counts. Shares divide by his team's totals in the same weeks he played.
const RATE_KEY = /(_ypa|_ypt|_ypr|_ypc|_rtg|_pct|_avg|_lng)$/;
const l4End = () => Math.max(1, Math.min(S.ui.scope === 'weekly' ? S.week : S.curWeek, S.curWeek));
// a window that ends before the current week is final: it never needs rebuilding
// when the live pull bumps statsGen, and it is never evicted for it
const l4Key = (end) => end < S.curWeek ? `${end}:final` : `${end}:${statsGen}`;
async function loadL4(end) {
    if (S.seasonType !== 'regular') return;
    S.l4 = S.l4 || {};
    const key = l4Key(end);
    if (S.l4[key]) return;
    const weeks = []; for (let w = Math.max(1, end - 5); w <= end; w++) weeks.push(w);
    await Promise.all(weeks.map(w => loadStats(w)));
    const played = (x) => x && x.stats && ((x.stats.off_snp || 0) > 0 || (x.stats.gp || 0) > 0);
    const games = {};
    for (const w of weeks.slice().reverse()) for (const [pid, x] of Object.entries(S.stats[w] || {})) { if (!played(x)) continue; const a = games[pid] = games[pid] || []; if (a.length < 4) a.push(w); }
    const m = {};
    for (const [pid, ws] of Object.entries(games)) {
        const e = { pid, pts: 0, gp: ws.length, weeks: ws, stats: {}, tm: { tgt: 0, car: 0, air: 0 } };
        const team = (P(pid) || {}).team;
        for (const w of ws) {
            const x = S.stats[w][pid]; e.pts += x.pts || 0;
            for (const [k, v] of Object.entries(x.stats)) if (typeof v === 'number' && !RATE_KEY.test(k)) e.stats[k] = (e.stats[k] || 0) + v;
            const tt = team && teamTotals(S.stats[w])[team]; if (tt) { e.tm.tgt += tt.tgt; e.tm.car += tt.car; e.tm.air += tt.air; }
        }
        m[pid] = e;
    }
    // the most games anyone could have in this window — "3 g" only means something below it
    Object.defineProperty(m, 'maxGp', { value: Math.max(0, ...Object.values(m).map(e => e.gp)), enumerable: false });
    // the key carries statsGen, which every live pull bumps — on a Sunday that is a
    // new pool every few seconds, so only the pools for the current generation stay
    for (const k of Object.keys(S.l4)) if (!(k.endsWith(':final') || k.endsWith(`:${statsGen}`) || k.endsWith(`:${statsGen - 1}`))) delete S.l4[k];
    S.l4[key] = m;
}
// The pool for a window, or while a live pull's new one is being built, the newest one there is (a pull or two
// old: loadL4 keeps the last generation until the next lands). On a Sunday every pull retires the current pool,
// and a reader that asked for exactly that one drew "Loading…" all afternoon: the quick views never counted and
// the roster's movement arrows went (2026-10-18). wantL4 rebuilds the exact one behind it.
const l4Pool = (end) => {
    const e = end ?? l4End(), m = S.l4 || {}; if (m[l4Key(e)]) return m[l4Key(e)];
    const k = Object.keys(m).filter(x => x.startsWith(`${e}:`) && !x.endsWith(':final')).sort((a, b) => Number(b.split(':')[1]) - Number(a.split(':')[1]))[0];
    return k ? m[k] : null;
};
// The last four are rebuilt whenever a stats pull lands (statsGen), even a
// Friday stat correction. A view that reads them asks again when the pool it had
// was retired, rather than drawing dashes until the next page load.
function wantL4() {
    const pool = l4Pool();
    if (!(S.l4 || {})[l4Key(l4End())] && S.seasonType === 'regular' && !S.l4Loading) { S.l4Loading = true; loadL4(l4End()).then(() => { S.l4Loading = false; render(); }).catch(() => { S.l4Loading = false; }); }
    return pool;
}
const l4PoolNear = (end) => { const m = S.l4 || {}; return m[l4Key(end)] || m[`${end}:${statsGen - 1}`] || null; };
const l4Short = (line) => { const pool = l4Pool(); return !!(line && pool && line.gp < Math.min(4, pool.maxGp || 4)); };
// ── usage: how a player is used, from Sleeper's own stats ───────────────────
// Every number here is Sleeper's, the same weekly and season pulls the pages
// already make. The shares need the TEAM's totals, and every player at every
// position is in the pull, so a pool is summed once and remembered. Sleeper's
// air yards are counted on completions, not targets — so this is "air yards
// per catch", not depth of target.
const USAGE = {
    snp:    ['SNAP%', 'share of his team’s offensive snaps', 'pct'],
    tsh:    ['TGT%', 'target share: his targets over his team’s', 'pct'],
    csh:    ['CAR%', 'carry share: his carries over his team’s', 'pct'],
    adoc:   ['AIR/REC', 'air yards per catch — how far downfield his catches come', 'f1'],
    ryac:   ['YAC', 'yards after the catch', 'f0'],
    yco:    ['YCO', 'yards after contact, rushing', 'f0'],
    ypc:    ['YPC', 'yards per carry', 'f1'],
    ypt:    ['Y/TGT', 'yards per target', 'f1'],
    touch:  ['TOUCH', 'carries + targets', 'f0'],
    rz:     ['RZ', 'red-zone plays that went through him: carries + targets, or a quarterback’s passes + carries', 'f0'],
    rtg:    ['RTG', 'passer rating', 'f1'],
    cmp:    ['CMP%', 'completion percentage', 'f1'],
    ypa:    ['YPA', 'yards per attempt', 'f1'],
    sck:    ['SACKED', 'times sacked', 'f0'],
    att:    ['ATT', 'pass attempts', 'f1'],
    aircmp: ['AIR/CMP', 'air yards per completion', 'f1'],
    opp:    ['OPP PTS', 'what his share of the offence is usually worth, in this league’s scoring', 'f1'],
};
// The price list for a back: the stat line backs got from one carry and from one
// target, outside the red zone and inside it, in 2023–25 (Sleeper's box scores).
// Rushing stats are fit on carries and receiving stats on targets.
const OPP_RB = { carry: { rush_yd: 4.4778, rush_td: 0.0098, rush_fd: 0.1967, fum_lost: 0.0037 }, rz_carry: { rush_yd: 3.9352, rush_td: 0.1471, rush_fd: 0.194, fum_lost: 0.0007 },
    target: { rec: 0.784, rec_yd: 5.8469, rec_td: 0.0107, rec_fd: 0.2331, fum_lost: 0.0072 }, rz_target: { rec: 0.7772, rec_yd: 5.2029, rec_td: 0.1823, rec_fd: 0.1904, fum_lost: -0.0028 } };
// Opportunity points, for backs, receivers and tight ends alike. His share of
// his team's targets — and of its carries, for a back — times what a normal
// offence throws and runs in a game, priced by the stat line players at his
// position got from one target or one carry in 2023–25 (Sleeper's box scores,
// red zone and all). The league's own scoring prices that line through
// scoreStats, so the column is right in any format. Shares, not counts: over a
// few games a count follows the score of the games, a share follows the role.
// Tested out of sample on 2023–25, in standard, half and full PPR: early in the
// season, among players scoring the same, the one with more of it scored more
// the rest of the way. It did as well as plain touches for a back and better
// than pricing each carry and target one by one at every position, far better
// for a tight end; for a wide receiver, a rating that adds his share of the air
// yards explained a little more. By midseason points carry it, tight ends apart.
const OPP_GAME = { tgt: 31.29, rzt: 3.83, car: 26.88, rzc: 4.50 };
const OPP_REC = {
    WR: { target: { rec: 0.6369, rec_yd: 8.31, rec_td: 0.0245, rec_fd: 0.3515 }, rz_target: { rec: 0.6238, rec_yd: 5.5476, rec_td: 0.2258, rec_fd: 0.1917 } },
    TE: { target: { rec: 0.7279, rec_yd: 7.5246, rec_td: 0.0078, rec_fd: 0.3437 }, rz_target: { rec: 0.6973, rec_yd: 6.271, rec_td: 0.2963, rec_fd: 0.2183 } },
};
const OPP_LINE = (() => {
    const mix = (a, b, r) => { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) o[k] = (a[k] || 0) * (1 - r) + (b[k] || 0) * r; return o; };
    const rt = OPP_GAME.rzt / OPP_GAME.tgt, rc = OPP_GAME.rzc / OPP_GAME.car, o = {};
    for (const [pos, L] of Object.entries({ RB: OPP_RB, ...OPP_REC })) o[pos] = { target: mix(L.target, L.rz_target, rt), carry: L.carry ? mix(L.carry, L.rz_carry, rc) : null };
    return o;
})();
function oppShare(pos, tsh, csh) {
    const L = OPP_LINE[pos]; if (!L || tsh == null) return null;
    const x = { rec_tgt: tsh * OPP_GAME.tgt };
    for (const [k, v] of Object.entries(L.target)) x[k] = (x[k] || 0) + x.rec_tgt * v;
    if (L.carry && csh != null) { x.rush_att = csh * OPP_GAME.car; for (const [k, v] of Object.entries(L.carry)) x[k] = (x[k] || 0) + x.rush_att * v; }
    x[`bonus_rec_${pos.toLowerCase()}`] = x.rec;   // leagues that pay a position extra per catch
    return scoreStats(x);
}
// The column to scan first: opportunity points, wherever a back, a receiver or
// a tight end is on the row. A quarterback has none.
const keyColFor = (pos) => pos === 'QB' || pos === 'K' || pos === 'DEF' ? null : 'opp';
// One usage grid. The lead: what his role is worth, how much he plays, his
// red-zone work. Then his end of the passing game, then the ground game. The
// roster, Flex and All read in that order; a back's own tab leads with the
// ground game, and a receiver's has none.
const U_LEAD = ['opp', 'snp', 'rz'], U_REC = ['tsh', 'ypt', 'ryac', 'adoc'], U_RUSH = ['csh', 'ypc', 'yco'];
const USAGE_SETS = {
    SKILL: [...U_LEAD, ...U_REC, ...U_RUSH],
    RB: [...U_LEAD, ...U_RUSH, ...U_REC],
    WR: [...U_LEAD, ...U_REC],
    QB: ['att', 'rz', 'cmp', 'ypa', 'aircmp', 'sck', 'csh', 'ypc'],
};
USAGE_SETS.TE = USAGE_SETS.WR; USAGE_SETS.FLEX = USAGE_SETS.ALL = USAGE_SETS.SKILL;
// The player card adds the ones the tables have no room for.
const CARD_MORE = { QB: ['rtg'], RB: ['touch'] };
// A quarterback in the skill grid's slots, for the roster, where the columns are shared.
const QB_SLOTS = [null, 'att', 'rz', 'cmp', 'ypa', 'aircmp', 'sck', 'csh', 'ypc', null];
// Over more than one game the counts read per game, so a player who missed one
// is not marked down and the tooltip yardsticks mean the same thing in any window.
const PER_GAME = new Set(['ryac', 'yco', 'touch', 'rz', 'sck', 'att']);
const isUsage = (b) => b === 'usage' || b === 'usageS' || b === 'usageL4';
const usageFmt = (key, v) => v == null ? null : USAGE[key][2] === 'pct' ? `${Math.round(v * 100)}%` : USAGE[key][2] === 'f2' ? v.toFixed(2) : USAGE[key][2] === 'f1' ? fmt1(v) : Number.isInteger(v) ? fmt0(v) : fmt1(v);
const usageKeyOf = (pos) => pos === 'TE' ? 'WR' : (USAGE_SETS[pos] ? pos : null);
const teamTotalsCache = new WeakMap();
function teamTotals(pool) {
    if (!pool) return {};
    if (teamTotalsCache.has(pool)) return teamTotalsCache.get(pool);
    const t = {};
    for (const [pid, line] of Object.entries(pool)) {
        const st = line && line.stats; const tm = (P(pid) || {}).team; if (!st || !tm) continue;
        const e = t[tm] = t[tm] || { tgt: 0, car: 0, air: 0, snp: 0 };
        e.tgt += st.rec_tgt || 0; e.car += st.rush_att || 0; e.air += st.pass_air_yd || 0; e.snp = Math.max(e.snp, st.tm_off_snp || 0);
    }
    teamTotalsCache.set(pool, t);
    return t;
}
// NFL passer rating from the counts — the last-four pool has no rating to read.
function passerRating(st) {
    const att = st.pass_att; if (!att) return null;
    const c = (x) => Math.max(0, Math.min(2.375, x));
    const a = c(((st.pass_cmp || 0) / att - 0.3) * 5), b = c(((st.pass_yd || 0) / att - 3) * 0.25), d = c((st.pass_td || 0) / att * 20), e = c(2.375 - (st.pass_int || 0) / att * 25);
    return (a + b + d + e) / 6 * 100;
}
function usageVal(line, key, pool) {
    if (!line || !line.stats) return null;
    const v = usageRaw(line, key, pool);
    return v != null && PER_GAME.has(key) && line.gp > 1 ? v / line.gp : v;
}
function usageRaw(line, key, pool) {
    const st = line.stats, pos = ppos(line.pid), tm = (P(line.pid) || {}).team;
    let tt = line.tm || ((pool && tm) ? (teamTotals(pool)[tm] || null) : null);
    // A season's team totals cover every game the team has played. A man who missed some is measured
    // against the games he was there for: Sleeper counts the team's snaps over his games only, so
    // their share of the team's season cuts its targets, carries and air yards down to his.
    if (tt && !line.tm && tt.snp && st.tm_off_snp && st.tm_off_snp < tt.snp) { const f = st.tm_off_snp / tt.snp; tt = { tgt: tt.tgt * f, car: tt.car * f, air: tt.air * f }; }
    if (pos === 'K' || pos === 'DEF') return null;
    const share = (n, d) => (d && n != null ? n / d : null);
    // Sleeper leaves a stat out of the box score when it is zero. For a man who
    // played, a count that is not there is a zero: no targets is a 0% target
    // share, not an unknown one. A catch's yards are air yards plus yards after
    // the catch, so whichever of the two is left out is what the other does not
    // account for — five catches for 69 with 69 after the catch is no air yards.
    // Only catches with neither figure stay unknown.
    const on = (st.off_snp || 0) > 0 || (st.gp || 0) > 0, zero = (v) => v ?? (on ? 0 : null);
    const yac = st.rec_yar ?? (st.rec_air_yd != null ? (st.rec_yd || 0) - st.rec_air_yd : !st.rec && on ? 0 : null);
    switch (key) {
        case 'snp': return st.tm_off_snp ? (st.off_snp || 0) / st.tm_off_snp : null;
        case 'tsh': return tt ? share(zero(st.rec_tgt), tt.tgt) : null;
        case 'csh': return tt ? share(zero(st.rush_att), tt.car) : null;
        case 'adoc': return st.rec ? (st.rec_air_yd || 0) / st.rec : null;
        case 'ryac': return yac;
        case 'yco': return st.rush_yac ?? null;
        case 'ypc': return st.rush_ypa ?? (st.rush_att ? (st.rush_yd || 0) / st.rush_att : null);
        case 'ypt': return st.rec_ypt ?? (st.rec_tgt ? (st.rec_yd || 0) / st.rec_tgt : null);
        case 'touch': return ((st.rush_att || 0) + (st.rec_tgt || 0)) || null;
        case 'opp': return oppShare(pos, usageRaw(line, 'tsh', pool), usageRaw(line, 'csh', pool));
        case 'att': return st.pass_att ?? null;
        case 'rz': return ((pos === 'QB' ? st.pass_rz_att || 0 : st.rec_rz_tgt || 0) + (st.rush_rz_att || 0)) || null;
        case 'rtg': return st.pass_rtg ?? passerRating(st);
        case 'cmp': return st.cmp_pct ?? (st.pass_att ? (st.pass_cmp || 0) / st.pass_att * 100 : null);
        case 'ypa': return st.pass_ypa ?? (st.pass_att ? (st.pass_yd || 0) / st.pass_att : null);
        case 'sck': return st.pass_sack ?? null;
        case 'aircmp': return st.pass_cmp ? (st.pass_air_yd || 0) / st.pass_cmp : null;
        default: return null;
    }
}
function statVal(line, key) {
    if (!line || !line.stats) return null;
    if (USAGE[key]) return usageVal(line, key, line.tm ? null : line.gp != null ? S.seasonStats : S.stats[S.week]);
    const st = line.stats, pg = (v) => v != null && line.tm && line.gp > 1 ? v / line.gp : v;   // the last four: per game
    if (key === 'snap') { const a = st.off_snp, b = st.tm_off_snp; return (a != null && b) ? a / b * 100 : null; }
    if (key === 'pts_allow') return pg(st.pts_allow ?? st.fan_pts_allow ?? null);
    if (key === 'td') return pg(st.td ?? st.def_td ?? null);
    return pg(st[key] ?? null);
}
// ── header tooltips: what it is, how to use it, and a yardstick ─────────────
// Every usage header carries one. The yardstick is not stored: it is
// this season's players at the position in view, over the games the column
// covers, worked out when the tooltip opens (peerLine). Last year's league is
// never the measure of this year's.
const TIPS = {
    'u:snp': { name: 'Snap share', what: 'The share of his team’s offensive plays he was on the field for.',
        use: 'The floor under everything else, since he can’t earn looks from the sideline. Snaps usually rise a week or two before targets do, so a jump here is the earliest sign of a bigger role. A receiver under 60% is a part-timer whose weeks will swing.' },
    'u:tsh': { name: 'Target share', what: 'His targets as a share of all his team’s targets.',
        use: 'The best single predictor of a receiver’s fantasy points. Trust it over yards in a small sample: 25% with a quiet box score is still a start, because the looks are what carry into next week.' },
    'u:csh': { name: 'Carry share', what: 'His carries as a share of all his team’s carries.',
        use: 'Who owns the backfield. At 60% or more he’s a workhorse you start regardless of matchup. Under 40% he’s in a committee and needs a touchdown or a receiving role to pay off.' },
    'u:adoc': { name: 'Air yards per catch', what: 'How far past the line of scrimmage his catches were made. Sleeper counts air yards on completions only.',
        use: 'Tells you his role. High means a deep threat whose weeks boom or bust. Low means short-area work that needs volume or yards after the catch. A back’s is often below zero: his catches come behind the line.' },
    'u:ryac': { name: 'Yards after the catch', what: 'Receiving yards gained after the ball was caught.',
        use: 'What he creates on his own. Strong after-catch yardage makes a short-target role worth starting, and it holds up better from year to year than touchdowns do.' },
    'u:yco': { name: 'Yards after contact', what: 'Rushing yards gained after the first defender touched him.',
        use: 'A back’s own contribution beyond his blocking. Strong after-contact numbers hold up when the line struggles. Weak ones mean his yards per carry depend on the line in front of him.' },
    'u:ypc': { name: 'Yards per carry', what: 'Rushing yards divided by carries.',
        use: 'Noisy: one long run can swing a month. Use it as a tiebreaker behind carry share and red-zone work' + '.' },
    'u:rz': { name: 'Red-zone looks', what: 'Plays inside the opponent’s 20 that went through him: carries plus targets, and for a quarterback his passes plus his carries.',
        use: 'Where touchdowns come from. Red-zone work without touchdowns yet means they’re due. Touchdowns without red-zone work means he’s running hot, and that usually doesn’t last.' },
    'u:ypt': { name: 'Yards per target', what: 'Receiving yards divided by targets.',
        use: 'Efficiency on the looks he gets. Above 9 is excellent and often falls back. Below 7 on heavy volume means the offense is feeding him inefficiently, and he’s still a start for the volume.' },
    'u:opp': { name: 'Opportunity points', what: 'What his share of the offence is usually worth, per game, in this league’s scoring: his share of his team’s targets, and of its carries for a back, times what a normal offence throws and runs, priced by what players at his position got from each in 2023–25.',
        use: 'Scan this first early in the season, against his points per game: well below it means buy, well above it means sell. In 2023–25, among players who had scored the same over the first three weeks, the one with more of it scored more the rest of the way, in standard, half and full PPR. By midseason his points already carry most of it, except for tight ends, where it keeps helping.' },
    'u:att': { name: 'Pass attempts', what: 'Passes thrown, per game.',
        use: 'A quarterback’s volume. More attempts mean more yards and touchdowns available to him and to everyone he throws to.' },
    'u:touch': { name: 'Touches', what: 'Carries plus targets.',
        use: 'Raw volume. Around 19 a game is RB1 work for a back, and in PPR a target is worth more than a carry.' },
    'u:rtg': { name: 'Passer rating', what: 'The NFL’s passer rating formula.',
        use: 'A blunt summary that overweights touchdowns and interceptions. Use it as a sanity check, not as a start/sit input. ' + ('YPA is a better guide.') },
    'u:cmp': { name: 'Completion %', what: 'Completions divided by attempts.',
        use: 'Depends heavily on how far downfield he throws, so read it next to ' + ('AIR/CMP.') },
    'u:ypa': { name: 'Yards per attempt', what: 'Passing yards divided by attempts.',
        use: 'The best box-score efficiency number for a quarterback. 7.5 or more supports a high ceiling for him and his receivers. Under 6.7 caps his weekly upside.' },
    'u:sck': { name: 'Sacks taken', what: 'Times he was sacked.',
        use: 'Sacks kill drives and cost points. A quarterback taking three a game is behind a line that will cap his volume, and he’s a good matchup for the defense you stream against him.' },
    'u:aircmp': { name: 'Air yards per completion', what: 'How far downfield his completions travel, on average.',
        use: 'Big-play upside. A high number is good news for his deep receivers, and his weeks will swing more.' },

};

const tipId = (k) => 'u:' + k;
// data-tip on a header; the position picks the yardstick. Flex/All show a receiver's.
const tipAttrs = (k, pos, extra, pool) => { const id = k.includes(':') ? k : tipId(k); return TIPS[id] ? { 'data-tip': id, 'data-pos': pos || 'WR', 'data-extra': extra || null, 'data-pool': pool || null, tabindex: '0' } : {}; };
// The yardstick under a tooltip: this season's players at the position, over the
// same games as the column it explains. Three marks, the ones the player card
// draws on its strips and from the same arithmetic: the middle of those with a
// real role, the typical starter in this league, and the top scorers. A
// ground-game column on a receiver's or a mixed table is read against backs,
// who are the ones it is about. Fewer than ten with a role and there is none.
function peerLine(id, pos, where) {
    const k = id.slice(2);
    const at = U_RUSH.includes(k) && (pos === 'WR' || pos === 'TE') ? 'RB' : pos;
    if (!['QB', 'RB', 'WR', 'TE'].includes(at)) return null;
    const b = S.ui.basis, win = where === 'l4' || b === 'usageL4' ? 'last4' : b === 'usage' ? 'week' : 'season';
    const pool = win === 'last4' ? l4Pool() : win === 'week' ? S.stats[S.week] : S.seasonStats; if (!pool) return null;
    const get = (e) => { const x = usageVal(e, k, pool); return x == null && USAGE_ZERO.has(k) ? 0 : x; };
    const show = (x) => usageFmt(k, x);
    const d = usageDist(pool, at, k, get); if (!d) return null;
    const n = d.pop.length, mid = (d.pop[(n - 1) >> 1][0] + d.pop[n >> 1][0]) / 2;
    return { who: `${S.season} ${posLabel(at)}s \u00b7 ${win === 'last4' ? 'last 4 games' : win === 'week' ? `wk ${S.week}` : 'season'}`,
        marks: [`middle ${show(mid)}`, d.st != null ? `starter ${show(d.st)}` : null, d.top != null ? `top-${d.g.n} ${show(d.top)}` : null].filter(Boolean) };
}
let tipEl = null, tipTimer = null, tipMore = null, tipFor = null, tipX = -1, tipY = -1;
function tipHide() { clearTimeout(tipTimer); clearTimeout(tipMore); tipTimer = tipMore = null; tipFor = null; if (tipEl) tipEl.hidden = true; }
// A header's tooltip explains the column. A number's says his rank at the position, which the cell no longer prints.
function tipShow(el) {
    if (el.dataset.say != null) {
        tipDraw(el, [h('div', { class: 'bt-h' }, h('b', null, el.dataset.rank), h('span', null, levelWord(Number(el.dataset.step)))), ...el.dataset.say.split('\n').map((x) => h('p', null, x))], true);
        // his season follows. The first time it has to be fetched, so it waits for the pointer to settle;
        // once it is in hand it is drawn with the rest, and a page that redraws under the pointer does not flicker.
        if (el.sayMore) { const draw = () => { if (tipFor !== el) return; const more = el.sayMore(); if (more) { tipEl.append(more); tipEl.classList.add('more'); tipPlace(el); } };
            const G = (S.gameLog || {})[el.sayPid]; if (G && !G.loading) draw(); else tipMore = setTimeout(draw, 250); }
        return;
    }
    const t = TIPS[el.dataset.tip]; if (!t) return;
    const b = peerLine(el.dataset.tip, el.dataset.pos, el.dataset.pool);
    tipDraw(el, [
        h('div', { class: 'bt-h' }, h('b', null, t.name), h('span', null, 'Usage')),
        h('p', { class: 'bt-what' }, t.what), h('p', null, t.use),
        b ? h('div', { class: 'bt-b' }, h('span', { class: 'bt-bl' }, b.who), ...b.marks.map((x, i) => h('span', { class: i ? '' : 'mid' }, x))) : null,
        el.dataset.extra ? h('div', { class: 'bt-x' }, el.dataset.extra) : null]);
}
function tipDraw(el, kids, cell) {
    if (!tipEl) { tipEl = h('div', { role: 'tooltip' }); layer.appendChild(tipEl); }
    tipEl.className = cell ? 'btip cell' : 'btip';
    tipEl.innerHTML = '';
    tipEl.append(...kids.filter(Boolean));   // append() writes a null as the text "null": only real nodes go in
    tipEl.hidden = false;
    tipFor = el;
    tipPlace(el);
}
function tipPlace(el) {
    const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, ht = tipEl.offsetHeight;
    const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    const y = r.bottom + 8 + ht > innerHeight - 8 ? Math.max(8, r.top - ht - 8) : r.bottom + 8;
    tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
}
function wireTips() {
    const target = (e) => { const n = e.composedPath ? e.composedPath()[0] : e.target; return n && n.closest ? n.closest('[data-tip], [data-say]') : null; };
    shadow.addEventListener('mousemove', (e) => { tipX = e.clientX; tipY = e.clientY; }, { passive: true });
    shadow.addEventListener('mouseover', (e) => { const el = target(e); if (!el || el === tipFor) return; clearTimeout(tipTimer); tipTimer = setTimeout(() => tipShow(el), el.dataset.say != null ? 90 : 220); });   // a number answers at once; a header waits, so sweeping the strip does not flicker
    shadow.addEventListener('mouseout', (e) => { const el = target(e); if (el && !el.contains(e.relatedTarget)) tipHide(); });
    shadow.addEventListener('focusin', (e) => { const el = target(e); if (el) tipShow(el); });
    shadow.addEventListener('focusout', tipHide);
    shadow.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tipFor) { e.stopPropagation(); tipHide(); } }, true);
    root.addEventListener('scroll', tipHide, { passive: true });
}
// ── quick views: Underperforming · Overperforming ────────────────────────────
// One yardstick, read both ways: what a man scores a game against what his
// share of his offence is usually worth (OPP PTS), over the same games.
// Underperforming is a starter's opportunity scoring 2.5 or more a game below
// it. Points tend to follow opportunity, so these are the buy-lows and holds.
// Overperforming is the mirror, with one guard. The best players beat an
// average price for their work every year, and that is skill: run on the whole
// league the list is led by its stars. So it is kept to players drafted late
// who are scoring like starters. In 2019–25 receivers doing that without the
// usage went 0 for 14 at keeping it up, and backs 1 in 4. Both read the season
// through week 4, then the last four games, and both ask for three games once
// there are three to ask for: one game can put any gap on anyone. (A third
// view, Starter role, listed late picks used like starters. It went when these
// two took one yardstick.) Inputs are Sleeper's live fields and its ADP.
const QUICK = [
    ['under', 'Underperforming', 'Getting a starter’s opportunity and scoring 2.5 or more points a game below what it is usually worth (OPP PTS). Points tend to follow opportunity, so these are players to buy low, or to hold.'],
    ['over', 'Overperforming', 'Drafted outside the top 30 at his position (top 12 for TEs) or undrafted, scoring like a starter, and 2.5 or more points a game above what his opportunity is usually worth (OPP PTS). In 2019–25, receivers scoring like this without the usage went 0 for 14 at keeping it up; backs 1 in 4.'],
];
const QUICK_GAP = 2.5;
function quickRead() {

    const key = [statsGen, l4End(), S.curWeek, !!S.sleeperAdp, !!S.seasonStats, Object.keys(S.l4 || {}).length, S.playersAt, S.rosters.map((r) => (r.starters || []).join(',')).join('|')].join('|');
    if (S.quick && S.quick.key === key) return S.quick;
    const q = { key, under: new Map(), over: new Map(), ready: false };
    S.quick = q;
    if (S.seasonType !== 'regular' || !S.sleeperAdp || !S.seasonStats) return q;
    const end = l4End(), useL4 = end >= 5, pool = useL4 ? (l4End() === end ? wantL4() : l4Pool(end)) : S.seasonStats;   // and builds the pool if it is missing or a pull old
    if (!pool) return q;
    const adp = S.sleeperAdp, ref = useL4 ? null : pool, n = S.rosters.length || 12;
    const rows = [];
    for (const [pid, line] of Object.entries(pool)) {
        const pos = ppos(pid); if (!['WR', 'RB', 'TE'].includes(pos) || !line || !line.gp || !line.stats) continue;
        const opp = usageVal(line, 'opp', ref); if (opp == null) continue;   // the column's own figure, already a game's
        rows.push({ pid, pos, gp: line.gp, opp, ppg: (line.pts || 0) / line.gp });
    }
    // three games once there are three to ask for; before that, as many as have been played
    const minG = Math.min(3, Math.max(1, ...rows.map((r) => r.gp)));
    const byPos = {}; for (const r of rows) if (r.gp >= minG) (byPos[r.pos] = byPos[r.pos] || []).push(r);
    const late = (r) => { const a = adp[r.pid]; return a == null || a > (r.pos === 'TE' ? 12 : 30); };
    for (const [pos, arr] of Object.entries(byPos)) {
        // a points rank only means something once most of the position has played: mid-week-one "top 24" is a 3-point game
        if (arr.length < (pos === 'TE' ? 12 : 24) * 3) continue;
        arr.slice().sort((a, b) => b.ppg - a.ppg).forEach((r, i) => { r.prk = i + 1; });
        const d = usageDist(pool, pos, 'opp', (e) => usageVal(e, 'opp', ref)), started = startedAt(pos);
        for (const r of arr) {
            const gap = r.ppg - r.opp, e = { pid: r.pid, r, x: r.opp, y: r.ppg, res: gap, g: r.gp };
            const work = d ? statRank(d, r.opp, 1) : null;   // where his opportunity ranks: the first two levels are a starter's
            if (work && work.step <= 2 && gap <= -QUICK_GAP) q.under.set(r.pid, e);
            else if (late(r) && levelOf(r.prk, n, started) <= 2 && gap >= QUICK_GAP) q.over.set(r.pid, e);
        }
    }
    q.ready = true;

    return q;
}
// Why he is on the list, under his name: the two figures and the gap between them.
function quickTags(pid, qk, qr) {
    const e = qr[qk] && qr[qk].get(pid); if (!e) return null;
    return h('div', { class: 'qtags' }, h('span', null, qk === 'under'
        ? `work worth ${fmt1(e.x)} · scoring ${fmt1(e.y)} pts/g · ${fmt1(-e.res)} under it`
        : `scoring ${fmt1(e.y)} pts/g · work worth ${fmt1(e.x)} · ${fmt1(e.res)} over it`));
}

function pagePlayers() {
    const page = h('div', { class: 'page wide' });
    const my = S.myRoster; const ui = S.ui;
    const rostered = rosteredSet();
    const isHurt = (pid) => !!statusOf(pid);
    settleBasis(periodsFor());
    const basis = ui.basis; const isSeason = ui.scope === 'season', isL4 = ui.scope === 'last4'; const usage = isUsage(basis), adv = false, deep = usage || adv; const isActual = basis === 'wkActual' || basis === 'seasActual' || basis === 'l4Actual' || deep;
    // the quick views' counts need Sleeper's draft positions on every lens — loading them up front keeps the chips from growing later
    loadSleeperAdp().then(() => { if (S.sleeperAdpFresh) { S.sleeperAdpFresh = false; render(); } }).catch(() => {});

    // the last four for the table
    const l4Wait = (isL4 || ui.playersQuick || basis === 'usageS') && S.seasonType === 'regular' && !l4Pool();   // the season's arrows read the last four too

    if ((l4Wait) && !S.l4Loading) { S.l4Loading = true; Promise.all([l4Wait ? loadL4(l4End()) : null]).then(() => { S.l4Loading = false; render(); }).catch(() => { S.l4Loading = false; }); }
    if (basis === 'ros' && !(S.ros && S.rosFrom === Math.max(1, S.curWeek))) { if (!S.rosLoading) { S.rosLoading = true; loadRos().then(() => { S.rosLoading = false; render(); }).catch(() => { S.rosLoading = false; }); } }
    let list = Object.keys(S.proj[S.week] || {});
    if (my) for (const pid of my.players || []) if (!list.includes(pid)) list.push(pid);
    if (S.seasonProj) for (const pid of Object.keys(S.seasonProj)) if (!list.includes(pid)) list.push(pid);
    // No NFL team = retired or unsigned; Sleeper's season feed still lists them.
    list = list.filter(pid => { const p = P(pid); return p && POS_ORDER.includes(p.position) && (p.status !== 'Inactive' || p.position === 'DEF') && (ui.playersNflFa || p.position === 'DEF' || !!p.team); });
    if (ui.playersTab === 'all') { /* everyone */ }
    else if (ui.playersTab === 'available') list = list.filter(pid => !rostered.has(pid));
    else if (ui.playersTab === 'waivers') list = list.filter(pid => !rostered.has(pid) && onWaiversNow(pid));
    else if (ui.playersTab === 'fa') list = list.filter(pid => !rostered.has(pid) && !onWaiversNow(pid));
    else if (ui.playersTab === 'rostered') list = list.filter(pid => rostered.has(pid));
    else if (ui.playersTab === 'mine') list = my ? (my.players || []).slice() : [];
    else if (ui.playersTab === 'watched') list = list.filter(pid => S.watched && S.watched.has(pid));
    const flexSet = new Set(); for (const sl of starterSlots()) if (FLEX[sl]) for (const p of FLEX[sl]) flexSet.add(p);
    // First visit in a session opens on Flex: the backs, receivers and ends most
    // claims come from, instead of thirteen backup quarterbacks. A position picked
    // anywhere (here, or a lineup hole's "find one") is left as it is.
    if (!ui.playersPosSet) { ui.playersPosSet = true; if (ui.playersPos === 'ALL' && flexSet.size) ui.playersPos = 'FLEX'; }
    if (ui.playersPos === 'FLEX') list = list.filter(pid => flexSet.has(ppos(pid)));
    else if (ui.playersPos !== 'ALL') list = list.filter(pid => ppos(pid) === ui.playersPos);
    if (ui.playersTeam) list = list.filter(pid => (P(pid) || {}).team === ui.playersTeam);
    if (ui.playersInjured) list = list.filter(isHurt);
    if (ui.playersTrending) list = list.filter(pid => (((S.trending || {})[pid] || {}).add || 0) > 0);
    if (ui.playersHideBye) list = list.filter(pid => !isBye(pid, S.week));
    if (ui.playersQ) { const q = ui.playersQ.toLowerCase(); list = list.filter(pid => pname(pid).toLowerCase().includes(q) || ((P(pid) || {}).team || '').toLowerCase() === q); }
    if (ui.playersQuick && !QUICK.some(([k]) => k === ui.playersQuick)) ui.playersQuick = null;   // a view from an earlier build
    const qr = quickRead();
    const qCount = Object.fromEntries(QUICK.map(([k]) => [k, list.filter(pid => qr[k].has(pid)).length]));
    if (ui.playersQuick) list = list.filter(pid => qr[ui.playersQuick].has(pid));
    // Under Usage the columns follow the position tab — a receiver's shares and
    // depth, a back's carries and yards after contact — and All/Flex show the
    // set the skill positions share. K and DST keep their box score: usage is
    // not a kicking concept.
    const tabKey = usageKeyOf(ui.playersPos) || (['K', 'DEF'].includes(ui.playersPos) ? null : 'ALL');
    const keyCol = deep && tabKey ? keyColFor(ui.playersPos) : null;
    const cols = usage && tabKey ? slotCols(USAGE_SETS[tabKey])
        : STAT_COLS[ui.playersPos] || STAT_COLS.ALL;
    const ranks = ranksFor(basis);
    const netFor = (pid) => { const d = suggestDrop(pid); return (projOf(pid, S.week) || 0) - (d && d.pid ? (projOf(d.pid, S.week) || 0) : 0); };
    const val = (pid, f) => { const l = statLine(pid, basis); return f === 'pts' ? (l && l.pts != null ? (isL4 ? l.pts / (l.gp || 1) : l.pts) : -Infinity) : f === 'avg' ? (l && l.gp ? l.pts / l.gp : -Infinity)
        : f === 'rk' ? -(ranks.overall[pid] || 99999) : f === 'prk' ? -(ranks.pos[pid] || 99999)
        : f === 'own' ? ((S.research || {})[pid] || {}).owned || 0 : f === 'start' ? ((S.research || {})[pid] || {}).started || 0 : f === 'trend' ? (((S.trending || {})[pid] || {}).add || 0) - (((S.trending || {})[pid] || {}).drop || 0)
        : f === 'net' ? (my && !rostered.has(pid) ? netFor(pid) : -Infinity) : f === 'name' ? pname(pid) : f === 'gp' ? ((l || {}).gp || 0)
        : f.startsWith('st:') ? (statVal(l, f.slice(3)) ?? -Infinity) : 0; };
    let { f, d } = ui.playersSort;
    if (['proj', 'season', 'last'].includes(f)) f = 'pts';
    list.sort((a, b) => { const x = val(a, f), y = val(b, f); return typeof x === 'string' ? (d === 'asc' ? x.localeCompare(y) : y.localeCompare(x)) : (d === 'asc' ? x - y : y - x); });
    // a quick view arrives in its own order — strongest match first — until a header is clicked
    if (ui.playersQuick && ui.quickOrder) {
        const qm = qr[ui.playersQuick];
        const score = ui.playersQuick === 'under' ? (pid) => -qm.get(pid).res : (pid) => qm.get(pid).res;   // the widest gap first
        list.sort((a, b) => score(b) - score(a));
    }
    const shown = list.slice(0, 200);
    const th = (label, field, right, tip, cls, tipA) => h('th', { class: `${field ? 'sortable' : ''} ${right ? 'r' : ''} ${f === field && !(ui.playersQuick && ui.quickOrder) ? 'sort' : ''} ${cls || ''}`, title: tipA && tipA['data-tip'] ? null : (tip || '') + (field ? (tip ? ' — ' : '') + 'click to sort' : ''), onclick: field ? () => { ui.quickOrder = false; ui.playersSort = f === field ? { f: field, d: d === 'asc' ? 'desc' : 'asc' } : { f: field, d: field === 'name' ? 'asc' : 'desc' }; render(); } : null, ...(tipA || {}), ...(tipA && tipA['data-tip'] && field ? { 'data-extra': 'Click the header to sort by it.' } : {}) }, label, f === field && !(ui.playersQuick && ui.quickOrder) ? (d === 'asc' ? '▴' : '▾') : '');
    const teams = [...new Set(Object.keys(S.proj[S.week] || {}).map(pid => (P(pid) || {}).team).filter(Boolean))].sort();
    const toggle = (key, label, tip) => h('span', { class: `sel ${ui[key] ? 'on' : ''}`, title: tip, onclick: () => { ui[key] = !ui[key]; render(); } }, label);
    const check = (key, label, tip) => h('label', { class: `chk ${ui[key] ? 'on' : ''}`, title: tip }, h('input', { type: 'checkbox', checked: !!ui[key], onchange: () => { ui[key] = !ui[key]; render(); } }), h('i'), label);
    // Flex is the resting position when the league has one, so it is not a filter to clear
    const restPos = flexSet.size ? 'FLEX' : 'ALL';
    const anyFilter = ui.playersInjured || ui.playersTrending || ui.playersHideBye || ui.playersNflFa || ui.playersTeam || ui.playersPos !== restPos || ui.playersQ;
    const claims = my ? S.pending.filter(t => t.type === 'waiver' && (t.roster_ids || []).includes(my.roster_id)) : [];
    const wi = waiverInfo();
    const lab = (txt) => h('span', { class: 'flab' }, txt);
    const group = (...kids) => h('div', { class: 'fgroup' }, ...kids);
    // Show and Team live behind More: four checkboxes and a team picker cost a
    // whole row on every visit and are used on few of them. The button counts
    // what is on inside, so a filter never hides behind a closed menu.
    const moreOn = [ui.playersInjured, ui.playersTrending, ui.playersHideBye, ui.playersNflFa, !!ui.playersTeam].filter(Boolean).length;
    const moreMenu = h('div', { class: 'fmore' },
        h('button', { class: `btn sm ${moreOn ? 'on' : ''}`, onclick: (ev) => { ev.stopPropagation(); ui.moreOpen = !ui.moreOpen; render(); } }, moreOn ? `More \u00b7 ${moreOn}` : 'More', ' ', caret()),
        ui.moreOpen ? h('div', { class: 'fmorepop', onclick: (ev) => ev.stopPropagation() },
            lab('Show'), check('playersInjured', 'Injured only', 'Only players with an injury designation'), check('playersTrending', 'Trending only', 'Only players being added across Sleeper in the last 24h'), check('playersHideBye', 'Hide byes', `Hide players on bye in week ${S.week}`), check('playersNflFa', 'NFL free agents', 'Include players with no NFL team (unsigned or retired) — hidden by default'),
            lab('Team'), h('select', { class: `sel ${ui.playersTeam ? 'on' : ''}`, onchange: (e) => { ui.playersTeam = e.target.value; render(); } }, h('option', { value: '' }, 'All teams'), ...teams.map(tm => h('option', { value: tm, selected: tm === ui.playersTeam }, tm)))) : null);
    const filters = h('div', { class: 'card', style: 'padding:8px 12px' },
        // Two fixed rows, the same whatever the lens or period: nothing in them
        // appears or disappears with a choice, so nothing rewraps under the cursor.
        h('div', { class: 'filters fbrow' },
            group(lab('Pool'), h('div', { class: 'tabs' }, ...[['all', 'All'], ['available', 'Available'], ['waivers', 'Waivers'], ['fa', 'Free agents'], ['rostered', 'Rostered'], ['mine', 'Mine'], ['watched', '★ Watched']].map(([k, tt]) => h('span', { class: k === ui.playersTab ? 'on' : '', title: k === 'all' ? 'Every player: rostered, on waivers and free agents' : null, onclick: () => { ui.playersTab = k; render(); } }, tt)))),
            periodCluster(),
            my ? h('div', { class: 'claimbar' },
                h('span', { class: 'dim', title: wi.faab ? `$${faabLeft(my)} of $${wi.budget} FAAB left` : null }, wi.faab ? [h('b', { class: 'mono', style: 'color:var(--ink)' }, `$${faabLeft(my)}`), ' FAAB'] : [h('b', { class: 'mono', style: 'color:var(--ink)' }, `#${my.settings.waiver_position}`), ' waiver priority']),
                h('span', { class: 'dim' }, `· run ${runsWhen()}`),
                claims.length ? h('button', { class: 'lnk', 'data-act': 'tx-open', title: 'Your claims, in the Transactions drawer', onclick: (e) => { e.stopPropagation(); openTx({ tab: 'waivers' }); } }, `${claims.length} claim${claims.length === 1 ? '' : 's'} filed ›`) : null) : null),
        h('div', { class: 'filters fbrow' },
            group(lab('Position'), ...['ALL', ...POS_ORDER, ...(flexSet.size ? ['FLEX'] : [])].map(p => h('span', { class: `sel posf ${p} ${ui.playersPos === p ? 'on' : ''}`, title: p === 'FLEX' ? `This league's flex positions: ${[...flexSet].join('/')}` : null, onclick: () => { ui.playersPos = p; render(); } }, p === 'ALL' ? 'All' : p === 'DEF' ? 'DST' : p === 'FLEX' ? 'Flex' : p))),
            group(lab('Quick'), ...QUICK.map(([k, t, tip]) => {
                const ready = qr.ready, on = ui.playersQuick === k;
                // a view with nobody in it can't be picked; one that empties while picked stays, and the table says why.
                // Before the last four games are added up there is no count to show: picking the view is what adds them up.
                const ok = ready ? (qCount[k] > 0 || on) : S.seasonType === 'regular';
                const why = !ready ? (S.seasonType !== 'regular' ? 'Starts once the regular season has games.' : tip)
                    : qCount[k] ? tip : `Nobody in this pool fits ${t} right now. ${tip}`;
                return h('span', { class: `sel qchip ${on ? 'on' : ''} ${ok ? '' : 'off'}`, title: why, onclick: () => { if (!ok) return; ui.playersQuick = on ? null : k; ui.quickOrder = true; render(); ensureData().then(render).catch(fail); } }, t, ready ? h('i', { class: 'mono' }, qCount[k]) : null);
            })),
            h('div', { class: 'search', style: 'min-width:260px' }, '🔍', h('input', { placeholder: `Search ${list.length} player${list.length === 1 ? '' : 's'}\u2026  ( / )`, value: ui.playersQ, oninput: (e) => { ui.playersQ = e.target.value; renderKeepFocus(); } })),
            moreMenu,
            anyFilter ? h('span', { style: 'font-size:12px;cursor:pointer;color:var(--teal);font-weight:700', onclick: () => { Object.assign(ui, { playersInjured: false, playersTrending: false, playersHideBye: false, playersNflFa: false, playersTeam: '', playersPos: restPos, playersQ: '' }); render(); } }, 'Clear filters') : null,
            ));
    const pool = basisPool(basis) || {};
    const empty = !Object.keys(pool).length;
    const ptsLabel = isL4 ? 'Pts per game, last 4' : (basis === 'wkActual' || basis === 'usage' || (adv && !isSeason)) ? `Wk ${S.week} pts` : basis === 'wkProj' ? `Wk ${S.week} proj` : (basis === 'seasActual' || basis === 'usageS' || adv) ? 'Season pts' : 'ROS proj';
    const ptsShort = isL4 ? 'Pts/G' : ['wkActual', 'seasActual', 'usage', 'usageS'].includes(basis) ? 'Pts' : basis === 'wkProj' ? 'Proj' : 'ROS';
    // Column families (variant C): a named group row + alternating tints so
    // fourteen numeric columns stop reading as one grey field. Families follow
    // the position filter; the first group's name follows the period picker.
    const famOf = (k) => USAGE[k] ? (['tsh', 'ypt', 'ryac', 'adoc'].includes(k) ? 'Receiving' : ['csh', 'ypc', 'yco'].includes(k) ? 'Rushing' : ['cmp', 'ypa', 'aircmp', 'sck'].includes(k) ? 'Passing' : 'Role') : k.startsWith('pass') ? 'Passing' : k.startsWith('rush') ? 'Rushing' : k.startsWith('rec') ? 'Receiving' : /^(fg|xp)/.test(k) ? 'Kicking' : ['sack', 'int', 'fum_rec', 'td', 'safe', 'yds_allow', 'pts_allow'].includes(k) ? 'Defense' : null;
    const scopeN = 2 + (isSeason ? 1 : 0) + (isSeason && basis === 'seasActual' ? 1 : 0);
    const groups = [{ label: isL4 ? 'Last 4' : ui.scope === 'season' ? 'Season' : `Week ${S.week}`, n: scopeN }];
    let lastFam = null;
    for (const [k] of cols) { const fam = famOf(k) || lastFam || 'Stats'; if (fam === lastFam) groups[groups.length - 1].n++; else { groups.push({ label: fam, n: 1 }); lastFam = fam; } }
    groups.push({ label: 'Market', n: 3 });
    const bandCls = []; groups.forEach((gr, gi) => { for (let i = 0; i < gr.n; i++) bandCls.push(gi % 2 === 0); });
    const band = (cells) => { cells.forEach((el, i) => { if (el && bandCls[i]) el.classList.add('band'); }); return cells; };
    // Fixed column plan: widths depend on which columns exist, never on their
    // contents — sorting cannot make the table jump (the pet peeve rule).
    // Action, Player and Opp hold their px. The number columns are each a share of
    // the number columns' own px sum, so together they claim whatever the three
    // text columns leave: on a wide screen they spread in proportion to the plan
    // and the name stays beside its opponent. With every column in px the browser
    // stretched them all alike, and the Player column opened a gap after each name.
    // min-width holds the px plan, so a narrow screen gets exactly these widths
    // and scrolls rather than squeezing a stat until it clips.
    const TEXT_W = [84, 280, 92];   // Action · Player (the watch star lives on the name line) · Opp
    const NUM_W = [56, 62,   // Rank Proj
        ...(isSeason ? [44] : []), ...(isSeason && basis === 'seasActual' ? [52] : []),
        ...cols.map(([k, lbl]) => deep ? (k === keyCol ? 70 : lbl.length > 6 ? 64 : 56) : 58),   // labels run to seven characters; the seven-character ones get the room to say it
        52, 62, 70];   // Market
    const numSum = NUM_W.reduce((a, b) => a + b, 0), planW = numSum + TEXT_W.reduce((a, b) => a + b, 0);
    const colgroup = h('colgroup', null, ...TEXT_W.map(w => h('col', { style: `width:${w}px` })),
        ...NUM_W.map(w => h('col', { style: `width:${(100 * w / numSum).toFixed(4)}%` })));
    const grpRow = h('tr', { class: 'grp' }, h('th', { colspan: 2, class: 'fxsec' }), h('th', null, ''), ...groups.map((gr, gi) => h('th', { colspan: gr.n, class: `${gi % 2 === 0 ? 'band' : ''} ${gi === 0 ? 'qh' : ''}` }, gr.label)));
    const tbl = h('table', { class: 'dense fixedcols', style: `min-width:${planW}px` }, colgroup, grpRow, h('tr', null, h('th', { class: 'stk1' }, 'Action'), th('Player', 'name', false, null, 'stk2'), h('th', null, `Opp wk ${S.week}`),
        ...band([
            th('Rank', 'prk', true, `Rank at his position by ${ptsLabel.toLowerCase()}; his overall rank is on each cell`),
            th(ptsShort, 'pts', true, isL4 ? 'Points per game over his last four games played' : isSeason ? (basis === 'seasActual' ? 'Season points to date' : basis === 'ros' ? 'Remaining weeks projected, summed' : "Sleeper's full-season projection") : (isActual ? `Week ${S.week} points` : `Week ${S.week} projection, this league's scoring`)),
            isSeason ? th('GP', 'gp', true, basis === 'ros' ? 'Weeks remaining with a game' : 'Games') : null, isSeason && basis === 'seasActual' ? th('Avg', 'avg', true, 'Per game played') : null,
            ...cols.map(([k, lbl, tip]) => th(lbl, 'st:' + k, true, tip || null, null, deep ? tipAttrs(k, ['ALL', 'FLEX'].includes(ui.playersPos) ? 'WR' : ui.playersPos) : null)),
            th('Own%', 'own', true, '% of Sleeper leagues where rostered'), th('Start%', 'start', true, '% of Sleeper leagues where started'), th('Trend', 'trend', true, 'Adds minus drops across Sleeper, 24h'),
        ].filter(Boolean))));
    for (const pid of shown) {
        const pl = P(pid) || {}; const owner = ownerOf(pid); const isMine = my && owner && owner.roster_id === my.roster_id; const avail = !owner;
        const waiv = avail && onWaiversNow(pid);
        const tr = (S.trending || {})[pid] || {}; const trend = (tr.add || 0) - (tr.drop || 0);
        const sel = ui.composer && ui.composer.pid === pid;
        const line = statLine(pid, basis);
        const fresh = pl.news_updated && Date.now() - pl.news_updated < 48 * 3600e3;
        const depth = pl.depth_chart_position && pl.depth_chart_order ? `${pl.depth_chart_position}${pl.depth_chart_order}` : null;
        const g = gameOf(pid, S.week);
        tbl.append(h('tr', { class: sel ? 'pick' : isMine ? 'hl' : '', 'data-pid': pid, 'data-avail': avail ? (waiv ? 'waivers' : 'free') : 'no' },
            h('td', { class: 'stk1' }, actionCell(pid, { avail, waiv, isMine, owner, sel, my })),
            h('td', { class: 'stk2' }, h('div', { class: 'pl' }, h('span', { class: `pos txt ${pl.position}` }, posLabel(pl.position)), h('div', { style: 'min-width:0' }, h('div', { class: 'nm', onclick: () => { S.ui.sel = pid; render(); } }, pname(pid), teamMeta(pid), injuryChip(pid), newsIcon(pid), starEl(pid)),
                h('div', { class: 'sub' }, bioText(pid),
                    isMine ? null : avail ? h('span', null, `${bioText(pid) ? ' · ' : ''}${waiv ? 'waivers' : 'FA'}`) : owner ? h('span', { class: 'ownr' }, `${bioText(pid) ? ' · ' : ''}${teamName(owner).slice(0, 14)}`) : null),
                ui.playersQuick && deep ? quickTags(pid, ui.playersQuick, qr) : null))),   // the why is usage: under Proj or Actual it only made every row taller
            oppCell(pid, S.week),
            ...band([
            h('td', { class: 'r mono', title: ranks.overall[pid] ? `${ordinal(ranks.overall[pid])} overall` : null }, ranks.pos[pid] ? h('span', { class: `pos txt ${pl.position}` }, `${posLabel(pl.position)}${ranks.pos[pid]}`) : h('span', { class: 'dim' }, '—')),
            h('td', { class: 'r mono', style: 'font-weight:700' }, line && line.pts != null ? (isL4 ? [fmt1(line.pts / (line.gp || 1)), l4Short(line) ? h('span', { class: 'was' }, `${line.gp} g`) : null] : isSeason ? fmt0(line.pts) : isActual ? fmtS(line.pts) : fmt1(line.pts)) : h('span', { class: 'dim' }, '—')),
            isSeason ? h('td', { class: 'r mono dim' }, line && line.gp != null ? fmt0(line.gp) : (line && line.stats && line.stats.gp != null ? fmt0(line.stats.gp) : '—')) : null,
            isSeason && basis === 'seasActual' ? h('td', { class: 'r mono' }, line && line.gp ? fmt1(line.pts / line.gp) : '—') : null,
            ...cols.map(([k]) => {
                const kc = k === keyCol ? ' keycol' : '';
                if (U_RUSH.includes(k) && (pl.position === 'WR' || pl.position === 'TE') && (statVal(line, 'csh') || 0) < 0.05) return h('td', { class: 'r mono' });

                const v = statVal(line, k);
                // a usage number is drawn at its level at the position and says his rank when pointed at; over the season an arrow says which way his last four games went
                if (deep && GRADE[k] && v != null) { const unit = rateUnit(k), work = unit ? workFor(line, pl.position, unit) : null, short = !!work && !work.ok;   // too little behind a rate: not ranked
                    const d = usageDist(pool, pl.position, k, (e) => { const x = usageVal(e, k, pool); return x == null && USAGE_ZERO.has(k) ? 0 : x; }), r = short ? null : statRank(d, v, GRADE[k]), mv = basis === 'usageS' ? moveOf(pid, pl.position, k) : null;
                    const why = [r ? rankSays(pl.position, r, work) : null, k === 'opp' ? oppWork(line) : null, mv ? `last ${mv.games} games ${usageFmt(k, mv.now)}, season ${usageFmt(k, mv.was)}` : null].filter(Boolean);
                    const td = h('td', Object.assign({ class: `r mono${kc}${r ? ' lv' + r.step : short ? ' lv0' : ''}` }, r ? say(pl.position, r.rk, r.step, why) : short ? unranked(work) : { title: why.join(' \u00b7 ') || null }), moveMark(mv), usageFmt(k, v));
                    if (d && (r || short)) { td.sayMore = () => seasonTip(pid, pl.position, k, d, (x) => usageFmt(k, x)); td.sayPid = pid; }
                    return td; }
                // a style is never ranked: on too little work it is drawn dim, and either way its season is a hover away
                if (deep && v != null && USAGE[k] && rateUnit(k)) { const work = workFor(line, pl.position, rateUnit(k)), d = usageDist(pool, pl.position, k, (e) => usageVal(e, k, pool));
                    const td = h('td', Object.assign({ class: `r mono${work.ok ? '' : ' lv0'}${kc}` }, work.ok ? { 'data-say': 'A style, not a grade: it carries no rank.', 'data-rank': USAGE[k][0], 'data-step': '0' } : unranked(work, true)), usageFmt(k, v));
                    if (d) { td.sayMore = () => seasonTip(pid, pl.position, k, d, (x) => usageFmt(k, x)); td.sayPid = pid; }
                    return td; }
                return h('td', { class: `r mono${kc}`, title: k === 'opp' && v != null ? oppWork(line) : null }, v == null ? h('span', { class: 'dim' }, '—') : USAGE[k] ? usageFmt(k, v) : (k === 'snap' ? fmt0(v) + '%' : isL4 ? (Number.isInteger(v) ? fmt0(v) : fmt1(v)) : (isActual || isSeason) ? fmt0(v) : (Math.abs(v) < 10 ? fmt1(v) : fmt0(v))));
            }),
            h('td', { class: 'r mono' }, S.research && S.research[pid] ? `${Math.round(S.research[pid].owned)}` : h('span', { class: 'dim' }, '—')),
            h('td', { class: 'r mono dim' }, S.research && S.research[pid] ? `${Math.round(S.research[pid].started)}` : '—'),
            h('td', { class: 'r' }, trend ? h('span', { class: `delta ${trend > 0 ? 'up' : 'dn'}`, title: `+${tr.add || 0} adds / −${tr.drop || 0} drops in 24h` }, `${trend > 0 ? '▲' : '▼'}${Math.abs(trend) >= 1000 ? (Math.abs(trend) / 1000).toFixed(1) + 'k' : Math.abs(trend)}`) : h('span', { class: 'dim' }, '—')),
            ].filter(Boolean))));
    }
    const quickName = ui.playersQuick && (QUICK.find(([k]) => k === ui.playersQuick) || [])[1];
    const quickWhy = ui.playersQuick === 'under' ? ' Nobody in this pool is getting a starter\u2019s work without the points right now.' : ' Nobody drafted late is scoring well above his workload in this pool and position.';
    if (!shown.length) tbl.append(h('tr', null, h('td', { colspan: 24, class: 'empty' }, quickName && !qr.ready ? 'Loading\u2026' : quickName && S.proj[S.week]
        ? [h('b', null, `Nobody fits ${quickName} yet.`), quickWhy, ' ', h('span', { class: 'teal', style: 'cursor:pointer;font-weight:700', onclick: () => { ui.playersQuick = null; render(); } }, `Clear ${quickName}`)]
        : S.proj[S.week] ? 'No players match these filters.' : 'Loading…')));
    // The views open as soon as games are played. A small sample is said once,
    // here, not on every row: a tag per row only repeated it and made rows taller.
    const quickG = ui.playersQuick ? shown.map(pid => (qr[ui.playersQuick].get(pid) || {}).g).filter(Boolean) : [];
    const quickFew = quickG.filter(g => g < 3), gLo = Math.min(...quickFew), gHi = Math.max(...quickFew);
    const fewNote = quickFew.length ? h('div', { class: 'cap', style: 'margin:0 0 6px' }, h('b', null, 'Small sample. '),
        quickFew.length === quickG.length ? `Every player here rests on ${gLo === gHi ? gLo : `${gLo}\u2013${gHi}`} game${gHi === 1 ? '' : 's'}.` : `${quickFew.length} of ${quickG.length} rest on fewer than 3 games.`,
        ' A single game can swing a player\u2019s share of the work either way \u2014 leads to check, not verdicts.') : null;
    const note = l4Wait ? h('div', { class: 'cap', style: 'margin:0 0 6px' }, h('span', { class: 'spin' }), 'Adding up everyone\u2019s last four games\u2026') : basis === 'ros' && S.rosLoading ? h('div', { class: 'cap', style: 'margin:0 0 6px' }, h('span', { class: 'spin' }), `Summing projections for weeks ${Math.max(1, S.curWeek)}–${LAST_WEEK}…`) : empty && isActual ? h('div', { class: 'cap', style: 'margin:0 0 6px' }, isSeason ? 'No games played yet this season — the season line fills in from week 1.' : `No stats for week ${S.week} yet.`) : fewNote;
    // Every usage header explains itself on hover; this says it in a line, so
    // nobody has to know what opportunity points are before sorting on them.
    const gloss = deep ? h('div', { class: 'gloss' }, levelKey(), h('span', null, 'He is ranked among the players at his position on the field for a quarter of their team’s snaps, over the same games. A rate is ranked only with enough work behind it; with too little it is drawn dim.'),
        basis === 'usageS' ? h('span', null, h('span', { class: 'trend up' }, '\u25b2'), h('span', { class: 'trend down' }, '\u25bc'), ' his last four games against his season; no mark is steady.') : null,
        ...cols.filter(([k]) => USAGE[k]).map(([k, lbl, tip]) => h('span', null, h('b', null, lbl), ' ', tip))) : null;

    const body = h('div', { class: 'scroll full', 'data-keep': 'players' }, tbl);
    page.append(filters, h('div', { class: 'card tblwrap' }, note, body, gloss, list.length > 200 ? h('div', { class: 'cap' }, `Showing 200 of ${list.length}. Narrow with the filters or search.`) : null));
    return page;
}
// One column says what you can do with him and what that means: Pick up
// (free agent, immediate), Claim (waivers — the clears deadline is the one
// caption that survives; ownership lives in the player sub-line), Trade (with
// whose he is), Drop (yours).
function svgIcon(kind, cls) {
    const s = document.createElementNS(SVG_NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', cls || '');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    const paths = { chat: ['M4 5h16v11h-9l-4 4v-4H4z'], minus: ['M5 12h14'], moves: ['M3 8h17M16 4l4 4-4 4', 'M21 16H4M8 12l-4 4 4 4'], news: ['M4 5h13a2 2 0 0 1 2 2v10a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z', 'M19 7v10a2 2 0 0 0 2 2', 'M8 9h5M8 13h5M8 17h5'], out: ['M10 5H5v14h14v-5', 'M14 5h5v5', 'M19 5l-8 8'], plus: ['M12 5v14M5 12h14'], swap: ['M7 7h11l-3-3M17 17H6l3 3'], x: ['M6 6l12 12M18 6 6 18'] }[kind] || [];
    for (const d of paths) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
}
function newsIcon(pid) {
    const pl = P(pid) || {}; if (!pl.news_updated) return null;
    const fresh = Date.now() - pl.news_updated < 48 * 3600e3;
    const i = svgIcon('news', `newsi ${fresh ? 'fresh' : 'old'}`);
    i.appendChild((() => { const t = document.createElementNS(SVG_NS, 'title'); t.textContent = `News ${ago(pl.news_updated)} ago — click to read`; return t; })());
    i.addEventListener('click', (e) => { e.stopPropagation(); S.ui.sel = pid; render(); });
    return i;
}
// `tight` is the Players table's action column, 72px under the button: inside
// a day and a half of the run the hour joins the day, and "claims run Wed 12am"
// was cut off there, so that one place says "runs Wed 12a".
function clearsLabel(pid, tight) {
    const at = (S.waiverClears || {})[pid] || (waiverSet().has(pid) ? null : waiverRunAt(waiverWeek()));
    if (at) {
        const ms = at - Date.now(); if (ms <= 0) return 'clearing';
        const d = new Date(at), soon = ms < 36 * 3600e3, hr = d.getHours() % 12 || 12, am = d.getHours() < 12;
        const when = !soon ? DAY[d.getDay()] : tight ? `${DAY[d.getDay()]} ${hr}${am ? 'a' : 'p'}` : `${DAY[d.getDay()]} ${hr}${am ? 'am' : 'pm'}`;
        // a player nobody dropped is not "clearing": his game has kicked off, so
        // he is claim-only until the run
        return (S.waiverClears || {})[pid] ? `clears ${when}` : tight && soon ? `runs ${when}` : `claims run ${when}`;
    }
    return `runs ${runsWhen()}`;
}
function actionCell(pid, o) {
    const sub = (txt, cls, full) => h('div', { class: `dim ${cls || ''}`, style: 'font-size:10px;line-height:1.2;margin-top:2px;white-space:nowrap', title: full || null }, txt);
    if (o.avail) {
        if (o.waiv) return h('div', null, h('button', { class: `btn sm ico ${o.sel ? '' : 'warn'}`, disabled: !o.my, 'data-act': 'claim', onclick: () => openComposer(pid, true) }, svgIcon('plus'), 'Claim'), sub(clearsLabel(pid, true), 'amber', clearsLabel(pid)));
        return h('div', null, h('button', { class: `btn sm ico ${o.sel ? '' : 'p'}`, disabled: !o.my, 'data-act': 'add', onclick: () => openComposer(pid, false) }, svgIcon('plus'), 'Add'));
    }
    if (o.isMine) return h('div', null, h('button', { class: 'btn sm ico out drop', onclick: () => confirmDrop(pid) }, svgIcon('x'), 'Drop'));
    return h('div', null, h('button', { class: 'btn sm ico out trade', title: `Propose a trade with ${teamName(o.owner)} for ${pname(pid)}`, onclick: () => openTrade(o.owner.roster_id, pid) }, svgIcon('swap'), 'Trade'));
}
// Where a number stands at his position. Every usage row on the card carries a
// strip: each player at the position with a real role — on the field for a
// quarter of his team's snaps over his last four — is a dot on the row's own
// scale, and two marks sit under it: the typical starter (the middle of the men
// started in this league this week) and the top N (the middle of the N scoring
// most per game, N the number of teams). No good or bad colour: how deep a
// man catches the ball is a style, not a grade.
const USAGE_ZERO = new Set(['rz', 'touch', 'sck']);   // a count missing from the box score is a zero
const posGroups = new WeakMap();
function posGroup(pool, pos) {
    let m = posGroups.get(pool); if (!m) posGroups.set(pool, m = {});
    const started = S.rosters.flatMap(r => r.starters || []), sig = started.join(',');
    if (m[pos] && m[pos].sig === sig) return m[pos];
    // a week's lines carry no game count: there, he played if he took a snap
    const played = (e) => e.gp != null ? e.gp >= 1 : !!(e.stats && ((e.stats.off_snp || 0) > 0 || (e.stats.gp || 0) > 0));
    const men = Object.values(pool).filter(e => e && played(e) && ppos(e.pid) === pos);
    const inLineup = new Set(started), n = S.rosters.length || 12;
    const top = men.slice().sort((a, b) => (b.pts || 0) / (b.gp || 1) - (a.pts || 0) / (a.gp || 1)).slice(0, n);
    return (m[pos] = { sig, n, started: started.filter((p) => p && p !== '0' && ppos(p) === pos).length, role: men.filter(e => (usageVal(e, 'snp') ?? 0) >= 0.25), starters: men.filter(e => inLineup.has(e.pid)), topIds: new Set(top.map(e => e.pid)), top, rows: {} });
}
function usageDist(pool, pos, k, get) {
    const g = posGroup(pool, pos);
    if (k in g.rows) return g.rows[k];
    const ok = (v) => v != null && isFinite(v);
    const unit = rateUnit(k), men = unit ? g.role.filter((e) => workFor(e, pos, unit).ok) : g.role;   // a rate is ranked among those with the work behind it
    const pop = men.map(e => [get(e), e.pid]).filter(x => ok(x[0])).sort((a, b) => a[0] - b[0]);
    const mid = (men) => { const s = men.map(get).filter(ok).sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null; };
    return (g.rows[k] = pop.length >= 10 ? { g, pop, st: mid(g.starters), top: mid(g.top) } : null);
}
// his percentile among the position: players below him, and half of any tied
const usagePct = (d, x) => x == null ? null : Math.max(1, Math.min(99, Math.round((d.pop.filter(p => p[0] < x).length + d.pop.filter(p => p[0] === x).length / 2) / d.pop.length * 100)));
const svTitle = (t) => { const e = document.createElementNS(SVG_NS, 'title'); e.textContent = t; return e; };
const STARTER_MARK = (x, y) => `M${x} ${y} l3.6 5.4 h-7.2 z`;
const TOP_MARK = (x, y) => `M${x} ${y} l3.4 3.4 l-3.4 3.4 l-3.4 -3.4 z`;
// One scale per row, shared by the strip and the line of his games under the
// week: it spans the middle 96% of the position, so one outlier does not pin
// the rest to a wall, and stretches to reach his own numbers and the marks.
function usageScale(d, extra) {
    const pop = d.pop, at = (p) => { const i = (pop.length - 1) * p, a = Math.floor(i); return pop[a][0] + (pop[Math.ceil(i)][0] - pop[a][0]) * (i - a); };
    const span = [at(0.02), at(0.98), d.st, d.top, ...extra].filter(v => v != null && isFinite(v));
    const lo = Math.min(...span); let hi = Math.max(...span); if (hi - lo < 1e-9) hi = lo + 1;
    return { lo, hi };
}
function usageStrip(d, x, show, label, who, sc, W = 300) {
    const H = 30, base = 17, pop = d.pop, g = d.g;
    const { lo, hi } = sc || usageScale(d, [x]);
    const X = (v) => 5 + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (W - 10);
    const pct = usagePct(d, x);
    const said = [x == null ? `${who}: no games in the last six weeks` : `${who} ${show(x)}, ${ordinal(pct)} percentile of ${pop.length}`,
        d.st != null ? `typical starter ${show(d.st)}` : null, d.top != null ? `top ${g.n} ${show(d.top)}` : null].filter(Boolean).join('; ');
    const svg = sv('svg', { class: 'ustrip udots', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${label}: ${said}` });
    svg.append(sv('line', { class: 'axis', x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5 }));
    const bin = 5.2 * W / 300, stack = {};   // a narrower strip packs its columns closer; the dots keep their size
    for (const [v, pid] of pop) {
        const b = Math.round(X(v) / bin), n = stack[b] = (stack[b] || 0) + 1, cy = base - 2.4 - (n - 1) * 3.1;
        if (cy < 1) continue;   // the column is full: the rest of that pile would run off the top
        svg.append(sv('circle', { class: g.topIds.has(pid) ? 'pd top' : 'pd', cx: b * bin, cy, r: 1.6 }, svTitle(`${pname(pid)} · ${show(v)}`)));
    }
    if (d.st != null) svg.append(sv('path', { class: 'st', d: STARTER_MARK(X(d.st), base + 3) }, svTitle(`typical starter · ${show(d.st)}`)));
    if (d.top != null) svg.append(sv('path', { class: 'tp', d: TOP_MARK(X(d.top), base + 3) }, svTitle(`top ${g.n} · ${show(d.top)}`)));
    if (x != null) { const px = X(x); svg.append(sv('g', { class: 'me' }, sv('line', { x1: px, x2: px, y1: 0, y2: base + 1 }), sv('circle', { cx: px, cy: base - 3, r: 3.6 }), svTitle(`${who} · ${show(x)} · ${ordinal(pct)} percentile`))); }
    return svg;
}
// His season beside the numbers, on the row's scale: a place for every week,
// 1 to 18, so a week never moves and the rows line up week for week. His last
// four games are shaded, which ties the line to the LAST 4 number and to where
// the dots put him; dashes mark the typical starter. A week with no number —
// a bye, a game he sat out, a row that has none for that game — is a tick on
// the floor that says why, never a line drawn across it. Each mark is
// [week, value, why-not]; an undefined value is a week still loading.
const SEASON_W = 150, SEASON_H = 22, STRIP_W = 204;
function usageSeason(d, series, show, label, sc, l4w) {
    const W = SEASON_W, H = SEASON_H, has = (v) => v != null && isFinite(v);
    const X = (w) => 5 + (w - 1) * (W - 10) / (LAST_WEEK - 1);
    const Y = (v) => H - 3 - (Math.max(sc.lo, Math.min(sc.hi, v)) - sc.lo) / (sc.hi - sc.lo) * (H - 6);
    const marks = series.filter(m => has(m[1]) || m[2]), played = marks.filter(m => has(m[1]));
    if (!played.length) return null;
    const last = played[played.length - 1], band = (l4w || []).filter(w => played.some(m => m[0] === w));
    const svg = sv('svg', { class: 'uspark udots', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
        'aria-label': `${label}, his season by week: ${marks.map(([w, v, why]) => `week ${w} ${has(v) ? show(v) : why}`).join(', ')}${d.st != null ? `; typical starter ${show(d.st)}` : ''}` });
    if (band.length) svg.append(sv('rect', { class: 'l4band', x: X(Math.min(...band)) - 5, y: 0, width: X(Math.max(...band)) - X(Math.min(...band)) + 10, height: H, rx: 3 }, svTitle('his last four games')));
    svg.append(sv('line', { class: 'wkax', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
    if (d.st != null) svg.append(sv('line', { class: 'sl', x1: 0, x2: W, y1: Y(d.st), y2: Y(d.st) }, svTitle(`typical starter · ${show(d.st)}`)));
    let pen = false, path = '';
    for (const [w, v] of series) { if (!has(v)) { pen = false; continue; } path += `${pen ? 'L' : 'M'}${X(w).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true; }
    svg.append(sv('path', { class: 'sp', d: path.trim() }));
    for (const m of marks) svg.append(has(m[1])
        ? sv('circle', { class: m === last ? 'sg now' : 'sg', cx: X(m[0]), cy: Y(m[1]), r: m === last ? 2.6 : 1.8 }, svTitle(`week ${m[0]} · ${show(m[1])}`))
        : sv('line', { class: 'sn', x1: X(m[0]), x2: X(m[0]), y1: H - 4, y2: H }, svTitle(`week ${m[0]} · ${m[2]}`)));
    return svg;
}
// The same season, drawn for the tooltip of one number: his games, oldest first,
// against the three marks of his position over the games in view: the level of
// its top scorers, the typical starter's, and the middle of those with a role.
// Each mark is named where its line ends. A game with too little behind a rate
// is a hollow dot: one play's worth of news. In every cell this was too much;
// asked for, on one number, it is the answer to "and which way is he going".
function seasonTip(pid, pos, k, d, show) {
    const season = seasonWeeks(pid), unit = rateUnit(k), has = (v) => v != null && isFinite(v);
    const series = seriesFrom(season, (ln, pl) => { const x = usageVal(ln, k, pl); return x == null && USAGE_ZERO.has(k) ? 0 : x; });
    const played = series.filter((m) => has(m[1]));
    if (!played.length) return series.some((m) => m[1] === undefined) ? h('p', { class: 'bt-wait' }, 'His games are loading…') : null;
    if (played.length < 2) return null;   // one game is the number he is already looking at
    const thin = new Set(unit ? season.filter(([, x]) => x && x.ln && !workFor(x.ln, pos, unit).ok).map(([w]) => w) : []);
    const n = d.pop.length, mid = (d.pop[(n - 1) >> 1][0] + d.pop[n >> 1][0]) / 2;
    const refs = [[d.top, 'rt', `top ${d.g.n}`], [d.st, 'rs', 'starter'], [mid, 'rm', 'middle']].filter((r) => has(r[0]));
    const sc = usageScale(d, [...played.map((m) => m[1]), mid]);
    const W = 276, H = 92, x0 = 8, x1 = W - 96, y0 = 8, y1 = H - 18, wN = Math.max(4, series.length);
    const X = (w) => x0 + (w - 1) * (x1 - x0) / (wN - 1), Y = (v) => y1 - (Math.max(sc.lo, Math.min(sc.hi, v)) - sc.lo) / (sc.hi - sc.lo) * (y1 - y0);
    const svg = sv('svg', { class: 'tsp', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
        'aria-label': `${USAGE[k][0]} by game: ${series.map(([w, v, why]) => `week ${w} ${has(v) ? show(v) : why || 'loading'}`).join(', ')}; ${refs.map((r) => `${r[2]} ${show(r[0])}`).join(', ')}` });
    // the games in view are shaded when the view is his last four
    const inView = l4Basis() ? ((((l4Pool() || {})[pid] || {}).weeks) || []).filter((w) => played.some((m) => m[0] === w)) : [];
    if (inView.length) svg.append(sv('rect', { class: 'band', x: X(Math.min(...inView)) - 6, y: y0 - 4, width: X(Math.max(...inView)) - X(Math.min(...inView)) + 12, height: y1 - y0 + 8, rx: 3 }));
    svg.append(sv('line', { class: 'ax', x1: x0 - 4, x2: x1 + 6, y1: y1 + 4.5, y2: y1 + 4.5 }));
    // the marks, each named at the end of its line; names that would sit on each other are spread
    const labs = refs.map((r) => ({ r, y: Y(r[0]), at: Y(r[0]) })).sort((a, b) => a.at - b.at);
    for (let i = 1; i < labs.length; i++) if (labs[i].at - labs[i - 1].at < 11) labs[i].at = labs[i - 1].at + 11;
    const over = labs.length ? Math.max(0, labs[labs.length - 1].at - (y1 + 2)) : 0;
    for (const l of labs) { l.at -= over; const [v, cls, word] = l.r;
        svg.append(sv('line', { class: cls, x1: x0 - 4, x2: x1 + 6, y1: l.y, y2: l.y }), sv('line', { class: cls, x1: x1 + 6, x2: x1 + 12, y1: l.y, y2: l.at }));
        const t = sv('text', { class: `l${cls}`, x: x1 + 15, y: l.at + 3.5 }); t.textContent = `${word} ${show(v)}`; svg.append(t); }
    let pen = false, line = '';
    for (const [w, v] of series) { if (!has(v)) { pen = false; continue; } line += `${pen ? 'L' : 'M'}${X(w).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true; }
    svg.append(sv('path', { class: 'ln', d: line.trim() }));
    for (const [w, v, why] of series) {
        if (has(v)) svg.append(sv('circle', { class: thin.has(w) ? 'pt thin' : 'pt', cx: X(w), cy: Y(v), r: 2.8 }, svTitle(`week ${w} · ${show(v)}`)));
        else if (why) svg.append(sv('line', { class: 'gap', x1: X(w), x2: X(w), y1: y1 - 1, y2: y1 + 4 }, svTitle(`week ${w} · ${why}`)));
        const t = sv('text', { class: 'wk', x: X(w), y: H - 2 }); t.textContent = String(w); svg.append(t);
    }
    const work = unit && thin.size ? workFor(null, pos, unit) : null;
    return h('div', { class: 'bt-chart' }, h('div', { class: 'bt-cap' }, `${USAGE[k][0]} by game, weeks 1–${series.length}`), svg,
        work ? h('div', { class: 'bt-note' }, `A hollow dot is a game with under ${work.per} ${work.word[1]}.`) : null);
}
function usageLegend(g, pos, who, lines) {
    const gl = (...kids) => sv('svg', { class: 'udots', width: 12, height: 12, viewBox: '-6 -1 12 12', 'aria-hidden': 'true' }, ...kids);
    return h('div', { class: 'ulegend' },
        h('span', null, gl(sv('circle', { class: 'pd', cx: -2.5, cy: 6, r: 1.6 }), sv('circle', { class: 'pd top', cx: 2.5, cy: 6, r: 1.6 })), `each dot a ${pos} (brighter: the top ${g.n})`),
        h('span', null, gl(sv('g', { class: 'me' }, sv('line', { x1: 0, x2: 0, y1: 0, y2: 11 }), sv('circle', { cx: 0, cy: 7, r: 3.2 }))), who),
        g.starters.length ? h('span', null, gl(sv('path', { class: 'st', d: STARTER_MARK(0, 3) })), 'typical starter') : null,
        h('span', null, gl(sv('path', { class: 'tp', d: TOP_MARK(0, 2.5) })), `top ${g.n}`),
        lines ? h('span', null, gl(sv('line', { class: 'sl', x1: -6, x2: 6, y1: 5, y2: 5 }), sv('path', { class: 'sp', d: 'M-5 9 L0 6 L4 2' }), sv('circle', { class: 'sg now', cx: 4, cy: 2, r: 2.2 })), `beside the numbers: his season, weeks 1 to ${LAST_WEEK} · shaded: his last four games · dashes: the typical starter`) : null);
}
// Usage on the card: everything, for one player — the week, his last four
// games, the season — each row with its strip, on the last four.
function usageBlock(pid) {
    const pos = ppos(pid), key = usageKeyOf(pos);
    if (!key) return null;
    if (!S.seasonStats) loadSeasonStats().then(render).catch(() => {});

    const end = l4End();
    if (S.seasonType === 'regular' && !l4Pool(end) && !S.l4Loading) { S.l4Loading = true; loadL4(end).then(() => { S.l4Loading = false; render(); }).catch(() => { S.l4Loading = false; }); }
    const wk = (S.stats[S.week] || {})[pid] || null, l4 = (l4Pool(end) || {})[pid] || null, sea = (S.seasonStats || {})[pid] || null;
    if (!wk && !l4 && !sea) return null;
    const tipPos = pos === 'TE' ? 'TE' : key;
    const pool = l4Pool(end), who = (P(pid) || {}).last_name || pname(pid);
    const season = seasonWeeks(pid), seriesOf = (get) => seriesFrom(season, get);
    const viz = (k, label, get, show, withSeason) => {
        const d = pool && usageDist(pool, pos, k, get); if (!d) return [null, null];
        const x = l4 ? get(l4) : null, series = withSeason ? seriesOf(get) : [];
        const sc = usageScale(d, [x, ...series.map(m => m[1])]);   // usageScale drops the gaps
        return [usageStrip(d, x, show, label, who, sc, STRIP_W), series.length ? usageSeason(d, series, show, label, sc, l4 ? l4.weeks : []) : null];
    };
    const row = (k, label, tip, vals, [st, line] = []) => h('div', { class: 'urow' },
        h('span', { class: 'ulab' }, h('span', tipAttrs(k, tipPos, null, 'l4'), label), tip ? h('small', null, tip) : null, st),
        h('span', { class: 'usea' }, line || null),
        ...vals.map((v, i) => h('span', { class: `uv mono ${i === 2 ? 's' : ''}` }, v == null ? '—' : v)));

    // the table's set for his position, and the numbers the tables let go that still describe him
    const rows = [...USAGE_SETS[key], ...(CARD_MORE[key] || [])].map(k => {
        const get = (e, pl) => { const x = usageVal(e, k, pl); return x == null && USAGE_ZERO.has(k) ? 0 : x; };
        // the three numbers agree with the line under them: a count he did not record in a game he played is 0, not a dash
        const v = [[wk, S.stats[S.week]], [l4], [sea, S.seasonStats]].map(([ln, pl]) => (ln && ln.stats && ((ln.stats.off_snp || 0) > 0 || (ln.stats.gp || 0) > 0 || (ln.gp || 0) > 0) ? get(ln, pl) : usageVal(ln, k, pl)));
        return row(k, USAGE[k][0], USAGE[k][1], v.map(x => usageFmt(k, x)), viz(k, USAGE[k][0], get, (x) => usageFmt(k, x), true));
    });

    const head = (t) => h('div', { class: 'uhead' }, h('span', null, t), h('span', { class: 'hsea' }, t === 'USAGE' ? `WEEKS 1\u2013${LAST_WEEK}` : ''), h('span', null, `WK ${S.week}`), h('span', { class: 'lit' }, 'LAST 4'), h('span', null, 'SEASON'));
    const g = pool && rows.some(r => r.querySelector('.ustrip')) ? posGroup(pool, pos) : null;
    const dots = g ? ` Dots: the ${g.role.length} ${pos}s on the field for a quarter of their team’s snaps, last four games.${g.starters.length ? ` Typical starter: the middle of the ${g.starters.length} ${pos}s started in ${S.league.name} in week ${lineupRound()}.` : ''} Top ${g.n}: the middle of the ${g.n} scoring most per game.` : '';
    return h('div', { class: 'ublock', 'data-games': l4 ? l4.gp : 0 },
        g ? usageLegend(g, pos, who, rows.some(r => r.querySelector('.uspark'))) : null,
        head('USAGE'), ...rows,
        h('div', { class: 'gloss' }, h('span', null, `Usage from Sleeper. Counts per game over more than one game.${dots}`)));
}
function splitsBlock(pid) {
    const pos = ppos(pid); const cols = STAT_COLS[pos] || STAT_COLS.ALL;
    const rows = [[`Week ${S.week} · Actual`, statLine(pid, 'wkActual')], [`Week ${S.week} · Proj`, statLine(pid, 'wkProj')], ['Season · Actual', statLine(pid, 'seasActual')], ['RoS (Proj)', statLine(pid, 'ros')]].filter(([, l]) => l && l.stats);
    if (!rows.length) return null;
    const tbl = h('table', { class: 'dense', style: 'margin-top:10px' }, h('tr', null, h('th', null, ''), h('th', { class: 'r' }, 'Rk'), h('th', { class: 'r' }, 'Pos'), h('th', { class: 'r' }, 'Pts'), ...cols.map(([, l]) => h('th', { class: 'r' }, l))));
    const bases = { [`Week ${S.week} · Actual`]: 'wkActual', [`Week ${S.week} · Proj`]: 'wkProj', 'Season · Actual': 'seasActual', 'RoS (Proj)': 'ros' };
    for (const [label, line] of rows) { const rk = ranksFor(bases[label]); tbl.append(h('tr', null, h('td', { class: 'dim', style: 'font-size:11px' }, label), h('td', { class: 'r mono dim' }, rk.overall[pid] || '—'), h('td', { class: 'r mono' }, rk.pos[pid] ? `${pos}${rk.pos[pid]}` : '—'), h('td', { class: 'r mono', style: 'font-weight:700' }, label.startsWith('Week') ? fmt1(line.pts) : fmt0(line.pts)), ...cols.map(([k]) => { const v = statVal(line, k); return h('td', { class: 'r mono' }, v == null ? h('span', { class: 'dim' }, '—') : k === 'snap' ? fmt0(v) + '%' : (Math.abs(v) < 10 && label.startsWith('Week') ? fmt1(v) : fmt0(v))); }))); }
    return h('div', { class: 'scroll-x' }, tbl);
}
// ── the game log ─────────────────────────────────────────────────────────────
// Every week he has played this season: opponent, what he scored against what
// he was projected, the stat line and his share of snaps. Two small requests
// per player to Sleeper's per-player weekly stats and projections, scored by
// this league's rules, kept for the session.
async function loadGameLog(pid) {
    S.gameLog = S.gameLog || {};
    if (S.gameLog[pid]) return;
    S.gameLog[pid] = { loading: true };
    const q = `?season_type=regular&season=${S.season}&grouping=week`;
    try {
        const [st, pr] = await Promise.all([rest(`${API2}/stats/nfl/player/${pid}${q}`), rest(`${API2}/projections/nfl/player/${pid}${q}`).catch(() => ({}))]);
        S.gameLog[pid] = { st: st || {}, pr: pr || {} };
    } catch (e) { S.gameLog[pid] = { error: e.message }; }
}
// The season in one table, in order: the weeks he has played — opponent,
// points against the projection he carried in, his finish at his position, the
// stat line, his share of snaps — and then the weeks still to come, with
// Sleeper's projection drawn as an outlined bar on the same scale. The half
// ahead reads the weekly projections the rest-of-season total is summed from.
const AHEAD_SHOWN = 6;
function seasonTimeline(pid) {
    if (S.seasonType !== 'regular') return null;
    const G = (S.gameLog || {})[pid];
    if (!G) { loadGameLog(pid).then(render).catch(() => {}); return h('div', { class: 'cap' }, h('span', { class: 'spin' }), ' Reading his weeks…'); }
    if (G.loading) return h('div', { class: 'cap' }, h('span', { class: 'spin' }), ' Reading his weeks…');
    if (G.error) return h('div', { class: 'cap' }, `Sleeper did not return his weeks (${G.error}).`);
    const lastWeek = Math.min(LAST_WEEK, S.curWeek), pos = posLabel(ppos(pid));
    // A bye is his TEAM's week off, read from the NFL schedule. His own entries
    // cannot say it: a player ruled out has no stat line, and Sleeper drops his
    // projection too, so a scratch read as a bye — Kendre Miller's week 2, when
    // the Saints played in Baltimore. The team for a week is the nearest one his
    // entries name, so a player traded midseason is matched to the right slate.
    const teamAt = (w) => { for (let d = 0; d <= LAST_WEEK; d++) for (const x of [w - d, w + d]) { const t = (G.st[String(x)] || G.pr[String(x)] || {}).team; if (t) return t; } return (P(pid) || {}).team || null; };
    const rows = []; let playedNow = false;
    for (let w = 1; w <= lastWeek; w++) {
        const e = G.st[String(w)], stats = e && e.stats && Object.keys(e.stats).length ? e.stats : null;
        const played = stats && ((stats.gp || 0) > 0 || (stats.off_snp || 0) > 0 || ppos(pid) === 'DEF');
        if (w === S.curWeek && !played && !teamGameOver(pid, w)) continue;   // this week, until his team's game is over: it leads the weeks ahead
        if (w === S.curWeek) playedNow = true;
        const pe = G.pr[String(w)], proj = pe && pe.stats ? scoreStats(pe.stats) : null;
        const tm = teamAt(w), wk = S.schedule && S.schedule[w], g = wk && tm ? wk[tm] : null;
        if (!tm && !played) continue;   // on nobody's roster that week
        const bye = wk && Object.keys(wk).length ? !g : !((e && e.opponent) || (pe && pe.opponent));   // no schedule yet: his entries are all there is
        rows.push({ w, bye, opp: g ? `${g.home ? 'vs ' : '@'}${g.opp}` : (e && e.opponent) || (pe && pe.opponent) || null, stats: played ? stats : null, pts: played ? scoreStats(stats) : null, proj });
    }
    // what is left: this week if he has not played it, then every week after
    const ahead = [], ros = cardRos();
    if ((P(pid) || {}).team && S.curWeek >= 1) for (let w = playedNow ? S.curWeek + 1 : S.curWeek; w <= LAST_WEEK; w++) {
        const wk = S.schedule && S.schedule[w], g = gameOf(pid, w), pool = S.proj[w], e = pool && pool[pid], has = !!(e && e.pts != null);
        ahead.push({ w, bye: !!(wk && Object.keys(wk).length) && !g, opp: g ? `${g.home ? 'vs ' : '@'}${g.opp}` : (e && e.opp) || null, proj: has ? e.pts : null, rk: has ? poolRanks(pool).pos[pid] || null : null, loading: !pool && !ros.ready });
    }
    if (!rows.length && !ahead.length) return h('div', { class: 'cap' }, 'No games yet this season.');
    const scale = Math.max(30, ...rows.map(r => r.pts || 0), ...rows.map(r => r.proj || 0), ...ahead.map(a => a.proj || 0));
    const tbl = h('table', { class: 'glog tl' }, h('tr', null, h('th', null, 'Wk'), h('th', null, 'Opp'), h('th', { class: 'r' }, 'Pts'), h('th', null, 'Rank'), h('th', null, 'vs proj'), h('th', null, 'Line'), h('th', { class: 'r' }, 'Snap')));
    for (const r of rows) {
        if (!r.stats) { tbl.append(h('tr', { class: 'nog' }, h('td', { class: 'mono' }, r.w), r.bye ? h('td', { colspan: 6 }, 'bye') : [h('td', { class: 'mono' }, r.opp || '—'), h('td', { colspan: 5 }, 'did not play')])); continue; }
        const pts = r.pts || 0, pr = r.proj, rk = weekPosRank(pid, r.w);
        const tone = pr != null && pr > 0 ? (pts >= pr * 1.5 && pts >= 10 ? 'green' : pts < pr * 0.5 ? 'red' : '') : '';
        const snap = ppos(pid) !== 'K' && r.stats.tm_off_snp ? Math.round(100 * (r.stats.off_snp || 0) / r.stats.tm_off_snp) : null;   // a kicker has no share of the offence's snaps
        const atoms = gameStatAtoms(pid, r.stats);
        tbl.append(h('tr', null,
            h('td', { class: 'mono' }, r.w),
            h('td', { class: 'mono' }, r.opp || '—'),
            h('td', { class: `r mono ${tone}`, style: 'font-weight:700' }, fmtS(pts)),
            h('td', { class: 'mono rkc', title: rk ? `${pos}${rk} in week ${r.w}, by ${S.league.name}’s scoring` : null }, rk === undefined ? '…' : rk ? `${pos}${rk}` : '—'),
            h('td', null, h('div', { class: 'gbar', title: pr != null ? `${fmtS(pts)} scored · ${fmt1(pr)} projected` : `${fmtS(pts)} scored` },
                h('i', { class: pr != null && pts < pr ? 'under' : '', style: `width:${Math.min(100, 100 * Math.max(0, pts) / scale)}%` }),
                pr != null ? h('b', { style: `left:${Math.min(100, 100 * pr / scale)}%` }) : null)),
            h('td', { class: 'mono gline' }, atoms ? atoms.join(' · ') : '—'),
            h('td', { class: 'r mono dim' }, snap != null ? `${snap}%` : '—')));
    }
    if (ahead.length) {
        const fut = (a) => a.bye ? h('tr', { class: 'nog' }, h('td', { class: 'mono' }, a.w), h('td', { colspan: 6 }, 'bye'))
            : h('tr', { class: 'fut' }, h('td', { class: 'mono' }, a.w), h('td', { class: 'mono' }, a.opp || '—'),
                h('td', { class: 'r mono' }, a.proj != null ? fmt1(a.proj) : a.loading ? '…' : '—'),
                h('td', { class: 'mono rkc', title: a.rk ? `${pos}${a.rk} among week ${a.w}’s projections` : null }, a.rk ? `${pos}${a.rk}` : a.loading ? '…' : '—'),
                h('td', null, a.proj != null ? h('div', { class: 'gbar fut', title: `${fmt1(a.proj)} projected` }, h('i', { style: `width:${Math.min(100, 100 * Math.max(0, a.proj) / scale)}%` })) : null),
                h('td', { class: 'pjw', colspan: 2 }, a.proj != null ? (a.w === S.curWeek ? 'this week · projected' : 'projected') : a.loading ? '' : 'no projection yet'));
        const open = !!S.ui.cardAhead, rest = ahead.slice(AHEAD_SHOWN);
        tbl.append(h('tr', { class: 'secrow' }, h('td', { colspan: 7 }, 'Ahead · Sleeper’s projections')), ...ahead.slice(0, AHEAD_SHOWN).map(fut));
        // the fold stays where it is when pressed: the later weeks open beneath it
        if (rest.length) tbl.append(h('tr', { class: 'foldtr' }, h('td', { colspan: 7 }, h('button', { class: 'foldlnk', type: 'button', 'aria-expanded': String(open), 'data-focus': 'card-ahead', onclick: () => { S.ui.cardAhead = !open; render(); } },
            foldCaret(open), rest.length > 1 ? `Weeks ${rest[0].w}–${rest[rest.length - 1].w}` : `Week ${rest[0].w}`))), ...(open ? rest.map(fut) : []));
    }
    return h('div', null, h('div', { class: 'scroll-x' }, tbl), h('div', { class: 'cap' }, `Bar: points, on a 0–${Math.round(scale)} scale · tick: his projection that week · outlined: a projection. Rank: among ${pos}s that week, by ${S.league.name}’s scoring.`));
}
function historyBlock(pid) {
    if (S.history === undefined) S.history = {};
    const hst = S.history[pid];
    if (hst === undefined) { S.history[pid] = null; gql('league_transactions_by_player', `query league_transactions_by_player { league_transactions_by_player(league_id: "${S.leagueId}", player_id: "${pid}"){ adds drops type status status_updated created roster_ids settings } }`).then(d => { S.history[pid] = d.league_transactions_by_player || []; render(); }).catch(() => { S.history[pid] = []; }); }
    if (!hst || !hst.length) return hst && !hst.length ? h('div', { class: 'txnline' }, h('b', null, 'Transactions'), ' \u00b7 none on him in this league.') : null;
    return h('div', { style: 'margin-top:10px' }, h('div', { class: 'dim', style: 'font-size:10.5px;font-weight:800;letter-spacing:.08em;margin-bottom:4px' }, 'IN THIS LEAGUE'), h('div', { class: 'feed' }, ...hst.slice().sort((a, b) => b.created - a.created).slice(0, 5).map(txnRow)));
}
function injuryChip(pid, noBye) {
    const pl = P(pid) || {};
    // The mirror says BYE in the game line already, so it asks for no chip.
    if (!noBye && isBye(pid, S.week)) return h('span', { class: 'chip', title: 'On bye this week' }, 'Bye');
    const s = pl.injury_status; if (!s) return null;
    // Red is every designation that should worry you, NA included — a listed
    // injury with nobody willing to say he plays is not a mild state.
    const bad = /^(out|ir|pup|sus|nfi|cov|dnr|na)$/i.test(s);
    const short = { Questionable: 'Q', Doubtful: 'D', Out: 'OUT', IR: 'IR', PUP: 'PUP', Sus: 'SUS', NA: 'NA', COV: 'COV', DNR: 'DNR' }[s] || s;
    const tip = [s, pl.injury_body_part, pl.injury_notes, pl.practice_participation ? `Practice: ${pl.practice_participation}` : null, pl.practice_description, pl.injury_start_date ? `since ${pl.injury_start_date}` : null].filter(Boolean).join(' · ');
    // Just the designation; body part, notes and practice status live in the tooltip.
    return h('span', { class: `chip ${bad ? 'red' : 'amber'}`, title: tip }, short);
}
function renderKeepFocus() { const i = $('.search input'); const pos = i ? i.selectionStart : 0; render(); const j = $('.search input'); if (j) { j.focus(); try { j.setSelectionRange(pos, pos); } catch (e) {} } }
const allOnWaivers = () => !!((S.league.settings || {}).daily_waivers);
function waiverSet() {
    // Sleeper's list (league_players) first; the transaction log as a fallback
    // until it has loaded.
    if (S.waivers) return S.waivers;
    const s = new Set(); const days = (S.league.settings || {}).waiver_clear_days || 2;
    for (const t of [...(S.txns[S.week] || []), ...(S.txns[S.week - 1] || [])]) if (t.status === 'complete' && t.drops && Date.now() - (t.status_updated || t.created) < days * 86400e3) for (const pid of Object.keys(t.drops)) s.add(pid);
    return s;
}
// The week the pending run is about — the last one to have kicked off. The
// pages turn to the next week the morning after Monday night, but the claims
// filed on Monday's games run on Wednesday, so on Tuesday the window is still
// about the week that just finished. Asking about the new week instead is what
// made every played player look like a plain add.
function waiverWeek() {
    const w = Math.max(1, S.curWeek || S.week || 1);
    for (let i = w; i >= Math.max(1, w - 1); i--) { const k = weekKicks(i); if (k.length && Math.min(...k) <= Date.now()) return i; }
    return w;
}
function onWaiversNow(pid) {
    if (allOnWaivers() || waiverSet().has(pid)) return true;
    const wk = waiverWeek(), run = waiverRunAt(wk);
    if (!run || Date.now() >= run) return false;          // no weekly run, or this week's has already processed
    const kicked = teamKickedOff(pid, wk);
    return kicked === null ? allKickedOff(wk) : kicked;   // unsigned players wait for the whole slate
}
// Active roster spots free right now. IR and taxi sit outside the count, so a
// player stashed there does not hold an active spot.
function openRosterSlots() {
    const my = S.myRoster; if (!my) return 0;
    const cap = rosterPositions().filter(p => p !== 'IR' && p !== 'TAXI').length;
    const active = (my.players || []).filter(p => !(my.reserve || []).includes(p) && !(my.taxi || []).includes(p));
    return cap - active.length;
}
// ── which week the pages are about ───────────────────────────────────────────
// Sleeper's display week sits on a finished week until midweek: the morning
// after Monday night, Home still led with a final score, counted lineup
// problems against a game that was over, and Team opened on it. Once every game
// of that week is final AND the night after its last game has passed (6am local
// the next day — Tuesday morning for a Monday finish), the current week is the
// next one for Home, Team and Players. Monday night itself stays Monday night's:
// the result is the story until morning. The Scoreboard is where a week is
// reviewed, so it keeps the finished week until the next one's first kickoff.
// A week the user picks by hand is left alone.
const TURN_HOUR = 6;
function weekGames(w) {
    const kicks = S.kickWeek === w ? Object.values(S.kick || {}).filter(Boolean) : [];
    if (kicks.length) return { any: kicks.some(k => k.started || k.live || k.over || /complete|in_game|in_progress/i.test(k.status || '')), all: kicks.every(k => k.over || /complete/i.test(k.status || '')),
        last: Math.max(0, ...kicks.map(k => Date.parse(k.t) || 0)) || null };
    const g = S.schedule && S.schedule[w]; const v = g ? Object.values(g) : [];
    if (!v.length) return { any: false, all: false, last: null };
    // the schedule carries a date, not a kickoff time: noon keeps it on its own day in any US zone
    return { any: v.some(x => x && !/pre/i.test(x.status || 'pre_game')), all: v.every(x => x && /complete/i.test(x.status || '')),
        last: Math.max(0, ...v.map(x => (x && x.date ? Date.parse(`${x.date}T12:00:00`) : 0) || 0)) || null };
}
// 6am local on the day after the last game of the week
function turnAt(lastKick) { const d = new Date(lastKick); d.setDate(d.getDate() + 1); d.setHours(TURN_HOUR, 0, 0, 0); return d.getTime(); }
function settleWeek() {
    if (S.seasonType !== 'regular' || S.fracDone || S.ui.vault) return false;
    const w = S.curWeek; if (!(w >= 1 && w < LAST_WEEK)) return false;
    const g = weekGames(w); if (!g.all || !g.last || Date.now() < turnAt(g.last)) return false;
    S.curWeek = w + 1;
    if (!S.ui.weekPicked) S.week = defaultWeek(S.page);
    console.info(TAG, `week ${w} is final and its night has passed — pages move to week ${S.curWeek}`);
    return true;
}
const reviewWeek = () => (S.curWeek > 1 && !weekGames(S.curWeek).any ? S.curWeek - 1 : S.curWeek);
const defaultWeek = (page) => (page === 'matchup' ? reviewWeek() : S.curWeek);
// The week just finished, while the new one has not kicked off: Home's matchup
// card shows how it ended beside what comes next.
const turnWeek = () => (S.seasonType === 'regular' && S.week === S.curWeek && S.curWeek > 1 && !weekGames(S.curWeek).any ? S.curWeek - 1 : null);
// The next week a pickup can actually play for you: this week while kickoffs
// remain, otherwise next week. It flips at the last kickoff, not at midnight —
// which is what makes Sunday night behave (a Monday-nighter still counts).
function pickupWeek() {
    if (S.kickWeek !== S.curWeek) return S.curWeek;   // no kickoff data for the live week; assume it is still ahead
    const now = Date.now();
    const remaining = Object.values(S.kick || {}).some(g => g && g.status !== 'complete' && Date.parse(g.t) > now);
    return remaining ? S.curWeek : Math.min(LAST_WEEK, S.curWeek + 1);
}
// A player whose game has already kicked off cannot earn this week's points.
function alreadyPlayed(pid, week) { return week === S.curWeek && S.kickWeek === S.curWeek && muLocked(pid); }
function suggestDrop(pid) {
    const my = S.myRoster;
    if (openRosterSlots() > 0) return { pid: null };
    const active = (my.players || []).filter(p => !(my.reserve || []).includes(p) && !(my.taxi || []).includes(p));
    const startersSet = new Set((my.starters || []).filter(p => p && p !== '0'));
    const cands = active.filter(p => !startersSet.has(p)).sort((a, b) => (projOf(a, S.week) || 0) - (projOf(b, S.week) || 0));
    const same = cands.filter(p => ppos(p) === ppos(pid));
    return { pid: (same[0] || cands[0] || null) };
}
// ── the FAAB market: what this league has actually paid ──────────────────────
// A bid row is any waiver claim that carried a dollar amount, won or lost —
// the losses matter most: the highest failed bid is the price that wasn't
// enough. Current season is harvested live from S.txns; last season (via
// previous_league_id) is fetched once and cached, because in September the
// only price history a league has is last year's.
function harvestBidRows(list, season, rows) {
    for (const t of list || []) {
        if (t.type !== 'waiver' || !t.settings || t.settings.waiver_bid == null) continue;
        if (t.status !== 'complete' && t.status !== 'failed') continue;
        const pid = Object.keys(t.adds || {})[0]; if (!pid) continue;
        rows.push({ season, week: t.leg || null, pid, pos: ppos(pid), bid: t.settings.waiver_bid, ok: t.status === 'complete', rid: (t.roster_ids || [])[0] });
    }
    return rows;
}
async function loadPriceHistory() {
    if (S.histReady || S.histLoading) return;
    S.histLoading = true;
    try {
        const jobs = []; for (let w = 1; w <= Math.max(1, S.curWeek); w++) jobs.push(loadTxns(w));
        const prevId = S.league.previous_league_id;
        if (prevId && prevId !== '0' && !S.prevHist) {
            const prevSeason = String(Number(S.season) - 1);
            jobs.push(Promise.all(Array.from({ length: 18 }, (_, i) => rest(`${API}/league/${prevId}/transactions/${i + 1}`).catch(() => [])))
                .then(weeks => { const rows = []; for (const wk of weeks) harvestBidRows(wk, prevSeason, rows); S.prevHist = rows; }));
        }
        await Promise.all(jobs);
        S.histReady = true;
    } catch (e) { console.warn(TAG, 'priceHist:', e.message); S.histReady = true; S.prevHist = S.prevHist || []; }
    finally { S.histLoading = false; render(); }
}
function marketRead(pos) {
    if (!S.histReady) return null;                       // still reading
    const rows = [];
    for (let w = 1; w <= Math.max(1, S.curWeek); w++) harvestBidRows(S.txns[w], S.season, rows);
    for (const r of S.prevHist || []) rows.push(r);
    const comp = rows.filter(r => r.pos === pos);
    const wins = comp.filter(r => r.ok).sort((a, b) => b.bid - a.bid);
    const fails = comp.filter(r => !r.ok).sort((a, b) => b.bid - a.bid);
    let lo = null, hi = null;
    if (wins.length) {
        const asc = wins.map(r => r.bid).sort((a, b) => a - b);
        lo = asc[Math.floor((asc.length - 1) / 2)];       // median winning bid
        hi = asc[asc.length - 1];
        // a failed bid at/above the median moves the floor: that price lost
        if (fails.length && fails[0].bid >= lo) lo = Math.min(hi, fails[0].bid + 1);
    }
    const ev = wins.slice(0, 2).concat(fails.slice(0, 1));
    return { lo, hi, nWins: wins.length, nComp: comp.length, ev };
}
// Who else can outbid you: every rival's remaining FAAB, crossed with whether
// their roster is short at this position. "Short" = fewer bodies than starting
// slots (a hole), or, for flex-eligible positions, no spare over the starters.
function rivalBidders(pos) {
    const starts = starterSlots().filter(s => s === pos).length || (pos === 'DEF' || pos === 'K' || pos === 'QB' ? 1 : 0);
    const flexy = ['RB', 'WR', 'TE'].includes(pos);
    const needers = []; let others = 0, maxOther = 0;
    for (const R of S.rosters) {
        if (S.myRoster && R.roster_id === S.myRoster.roster_id) continue;
        const left = faabLeft(R);
        const bodies = (R.players || []).filter(p => ppos(p) === pos).length;
        const hole = bodies < starts, thin = flexy && bodies <= starts;
        if (hole || thin) needers.push({ R, left, hole });
        else { others++; if (left > maxOther) maxOther = left; }
    }
    needers.sort((a, b) => (b.hole - a.hole) || (b.left - a.left));
    return { needers, others, maxOther };
}
// ── transactions: one drawer for claims, adds and trades ─────────────────────
// Everything in flight for your team (claims you filed, offers either way, a
// trade in league review), the league's history of each kind, and the
// composers that start a move, in one drawer: the slot chat uses, one open at a
// time. The ⇄ count on the top bar opens the list; Claim, Add and Propose trade
// open a composer straight away, from wherever they are. Filing returns to the
// list with what you made on top.
//
// Every player row is built the same way, from the same parts as the Team and
// Players tabs: the name line (position, name, team (bye), injury tag, news),
// the week's opponent, then what the row is about, with this week's projection
// and rest of season in the same two columns.
const txWeek = () => pickupWeek();
const txWk = (pid) => projOf(pid, txWeek());
const txRos = (pid) => { const e = (S.ros || {})[pid]; return e && e.pts != null ? e.pts : null; };
const TX_SEEN = () => 'badgerTxSeen-' + S.leagueId;
function txSeenAt() { try { return Number(localStorage.getItem(TX_SEEN())) || 0; } catch (e) { return 0; } }
function txMarkSeen(at) { try { if (at > txSeenAt()) localStorage.setItem(TX_SEEN(), String(at)); } catch (e) { /* private window: the dot just stays */ } }
// When the next claims are processed, in words: "daily 3a", "Wed 3:05a", or
// the league's day when the week's kickoffs are not in hand yet.
function runsWhen() {
    const wi = waiverInfo(); const hr = wi.hour != null ? ` ${wi.hour % 12 || 12}${wi.hour < 12 ? 'a' : 'p'}` : '';
    if (allOnWaivers()) return `daily${hr}`;
    if (!wi.day) return 'by the commissioner';   // no weekly day: Sleeper runs them on request
    const at = waiverRunAt(waiverWeek());
    return at ? `${DAY[new Date(at).getDay()]} ${chatClock(at)}` : wi.day;
}
const myClaims = () => { const my = S.myRoster; return my ? S.pending.filter(t => t.type === 'waiver' && (t.roster_ids || []).includes(my.roster_id)) : []; };
const myTrades = () => { const my = S.myRoster; return my ? S.pending.filter(t => t.type === 'trade' && (t.roster_ids || []).includes(my.roster_id)) : []; };
// A trade both teams accepted is "pending" in Sleeper until the league's review ends, waiting on nobody but the
// commissioner. The drawer listed only your own team's trades, so a commissioner never saw one (2026-10-14).
// Sleeper's league users carry is_owner for the commissioner. The review runs from acceptance (status_updated).
const amCommish = () => (S.users || []).some(u => String(u.user_id) === String(S.myUserId) && u.is_owner);
const reviewTrades = () => amCommish() ? S.pending.filter(t => t.type === 'trade' && t.status === 'pending') : [];
const reviewEnds = (t) => (t.status_updated || t.created) + ((S.league.settings || {}).trade_review_days || 0) * 86400e3;
const atWhen = (ms) => `${DAY[new Date(ms).getDay()]} ${chatClock(ms)}`;
// An offer waits on you until your roster has consented; one every side has
// consented to is sitting out the league's review window.
function tradeRole(t) {
    const my = S.myRoster, ok = t.consenter_ids || [];
    if (t.status === 'pending' || ((t.roster_ids || []).length && (t.roster_ids || []).every(r => ok.includes(r)))) return 'review';
    return String(t.creator) === String(S.myUserId) || ok.includes(my.roster_id) ? 'sent' : 'toyou';
}
const inFlightCount = () => myClaims().length + myTrades().length;
// Waiver claims processed together, newest run first. A run's claims share a
// processing time to within seconds; three minutes of slack keeps a run whole.
function waiverRuns() {
    const all = [];
    for (let w = 1; w <= Math.max(1, S.curWeek); w++) for (const t of S.txns[w] || []) if (t.type === 'waiver' && (t.status === 'complete' || t.status === 'failed')) all.push(t);
    all.sort((a, b) => (b.status_updated || b.created) - (a.status_updated || a.created));
    const runs = [];
    for (const t of all) { const at = t.status_updated || t.created, r = runs[runs.length - 1]; if (r && r.at - at < 180000) r.txns.push(t); else runs.push({ at, txns: [t] }); }
    if (runs.length) runs[0].first = true;
    return runs;
}
// Players another team let go who are on waivers now: the one part of the
// free-agent churn you can act on.
function justDropped() {
    const my = S.myRoster, on = waiverSet(), rostered = rosteredSet(), seen = new Set(), out = [];
    const ts = [];
    for (let w = Math.max(1, S.curWeek - 1); w <= Math.max(1, S.curWeek); w++) for (const t of S.txns[w] || []) if (t.status === 'complete' && t.drops) ts.push(t);
    ts.sort((a, b) => (b.status_updated || b.created) - (a.status_updated || a.created));
    for (const t of ts) for (const [pid, rid] of Object.entries(t.drops)) {
        if (seen.has(pid)) continue; seen.add(pid);
        if ((my && rid === my.roster_id) || rostered.has(pid) || !on.has(pid) || !P(pid)) continue;
        out.push({ pid, rid, at: t.status_updated || t.created });
    }
    return out;
}
function txLoad(force) {
    if (S.txLoading || (!force && S.txLoadedAt && Date.now() - S.txLoadedAt < 60e3)) return;
    S.txLoading = true;
    const cw = Math.max(1, S.curWeek);
    const jobs = [loadPending(), loadWaivers(), loadTrending().catch(() => {}), loadRos().catch(() => {}), loadProj(txWeek()).catch(() => {}), loadL4(l4End()).catch(() => {}),

        // this week's list moves while you look at it; earlier weeks are settled
        rest(`${API}/league/${S.leagueId}/transactions/${cw}`).then(v => { S.txns[cw] = v; }).catch(() => {})];
    for (let w = 1; w < cw; w++) jobs.push(loadTxns(w));
    Promise.all(jobs).catch(() => {}).then(() => { S.txLoading = false; S.txLoadedAt = Date.now(); render(); });
}

// ── rows ──
// The Team tab's name line, exactly (playerCell uses it too).
function nameLine(pid, stop) {
    const pos = ppos(pid);
    return h('div', { class: 'nm', onclick: (e) => { if (stop) e.stopPropagation(); S.ui.sel = pid; render(); } },
        // the name is the one part allowed to give way: in a column too narrow for
        // everything it ends in an ellipsis, with the whole name on hover, and the
        // team, the injury chip and the news icon stay whole
        h('span', { class: `pos txt ${pos}` }, posLabel(pos)), h('span', { class: 'pnm', title: pname(pid) }, pname(pid)), teamMeta(pid), injuryChip(pid), newsIcon(pid), starEl(pid));
}
// The Players tab's opponent cell, on one line.
function oppLine(pid, week) {
    const g = gameOf(pid, week);
    if (!g) return h('div', { class: 'txopp mono dim' }, isBye(pid, week) ? 'BYE' : '—');
    const pl = P(pid) || {};
    const ko = alreadyPlayed(pid, week) ? 'played' : (week === S.week ? kickoffLabel(pl.team) : null) || DAY[new Date(g.date + 'T12:00:00').getDay()];
    return h('div', { class: 'txopp mono' }, `${g.home ? 'vs ' : '@'}${g.opp}`, oppRankEl(pid, week), h('span', { class: 'dim' }, ko));
}
const DIRS = { in: 'ADD', out: 'DROP', get: 'GET', send: 'SEND' };
function txRow(pid, o) {
    o = o || {};
    const lab = o.dir ? h('span', { class: `dir ${o.dir === 'in' || o.dir === 'get' ? 'in' : 'out'}` }, DIRS[o.dir]) : h('span');
    const played = alreadyPlayed(pid, txWeek());
    return h('div', Object.assign({ class: `txr ${o.cls || ''}`.trim() }, o.onclick ? { onclick: o.onclick } : {}, o.attrs || {}),
        h('img', { class: 'hs', src: headshot(pid), alt: '', loading: 'lazy', onerror: hideBroken }),
        lab,
        h('div', { class: 'txw' }, nameLine(pid, true), o.noOpp ? null : oppLine(pid, txWeek()), o.sub ? h('div', { class: 'txsub', title: [].concat(o.sub).map(x => typeof x === 'string' ? x : (x && x.textContent) || '').join('') }, o.sub) : null),
        h('span', { class: 'txn1' }, played ? '—' : fmt1(txWk(pid))),
        h('span', { class: 'txn2' }, txRos(pid) != null ? fmt0(txRos(pid)) : (S.ros ? '—' : '…')),
        o.btn ? h('span', { class: 'txbw' }, o.btn) : null);
}
// A section head whose last two columns line up with the rows' numbers.
function txHead(title, meta, opts) {
    opts = opts || {};
    return h('div', { class: `txhead ${opts.btns ? 'btns' : ''}`.trim() }, h('span', { class: 'txht' }, h('b', null, title), meta ? h('span', { class: 'shm' }, meta) : null),
        opts.right || h('span'), opts.cols === false ? null : h('span', { class: 'txc' }, `WK ${txWeek()}`), opts.cols === false ? null : h('span', { class: 'txc' }, 'RoS'), opts.btns ? h('span') : null);
}
const txEmpty = (text) => h('div', { class: 'txempty' }, text);
const kAdds = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
function txCard(o) {
    return h('div', Object.assign({ class: `txcard ${o.cls || ''}`.trim() }, o.attrs || {}),
        h('div', { class: 'txh' }, o.R ? avatarEl(o.R, 'xs') : null, h('b', { class: o.me ? 'me' : '' }, o.who),
            o.kind ? h('span', { class: 'txk' }, o.kind) : null, o.bid != null ? h('span', { class: 'txbid' }, `$${o.bid}`) : null,
            o.pill ? h('span', { class: `txpill ${o.pill[0]}` }, o.pill[1]) : null, o.when ? h('span', { class: 'txwhen' }, o.when) : null),
        ...(o.rows || []),
        (o.foot || (o.acts && o.acts.length)) ? h('div', { class: 'txf' }, h('span', { class: 'txft' }, o.foot || ''), o.acts && o.acts.length ? h('span', { class: 'txacts' }, ...o.acts) : null) : null);
}
const shortName = (pid) => { const p = P(pid) || {}; return ppos(pid) === 'DEF' ? pname(pid) : p.last_name ? `${(p.first_name || '?')[0]}. ${p.last_name}` : pname(pid); };
const seg = (labels, on, pick) => h('span', { class: 'txseg', role: 'group' }, ...labels.map((l, i) => h('button', { class: i === on ? 'on' : '', 'aria-pressed': i === on ? 'true' : 'false', onclick: () => pick(i) }, l)));

// ── the drawer: its frame ──
// Two tabs, by kind. Each has the thing you start with pinned on top (the search
// box; "Propose a trade"), and under it the parts: what is live, and History.
// Waivers & Adds also has Ideas, the players worth a look.
const TX_PARTS = { waivers: [['claims', 'Claims'], ['ideas', 'Ideas'], ['history', 'History']], trades: [['offers', 'Offers'], ['ideas', 'Ideas'], ['history', 'History']] };
// The commissioner's Trades has Review between them, always, so nothing moves when a trade arrives.
const txPartList = (tab) => tab === 'trades' && amCommish() ? [['offers', 'Offers'], ['ideas', 'Ideas'], ['review', 'Review'], ['history', 'History']] : TX_PARTS[tab];
const lastNm = (pid) => (ppos(pid) === 'DEF' ? pname(pid) : (P(pid) || {}).last_name || pname(pid));
const runDay = (at) => { const d = new Date(at); return `${DAY[d.getDay()]} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`; };
const NUMW = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const flagEl = (kind, word) => h('span', { class: `txflag ${kind}` }, word);
const pills = (list, cur, pick, label) => h('div', { class: 'txpl', role: 'group', 'aria-label': label }, ...list.map(([k, t]) => h('button', { class: cur === k ? 'on' : '', type: 'button', 'aria-pressed': String(cur === k), 'data-pill': k, onclick: () => pick(k) }, t)));
function txTabs() {
    const tx = S.ui.tx, nC = claimGroups().length, nT = new Set([...myTrades(), ...reviewTrades()]).size;
    const tab = (k, label, n) => h('button', { class: tx.tab === k ? 'on' : '', role: 'tab', 'aria-selected': tx.tab === k ? 'true' : 'false', 'data-tab': k, onclick: () => { tx.tab = k; render(); } }, label, n ? h('i', null, n) : null);
    return h('div', { class: 'txtabs', role: 'tablist' }, tab('waivers', 'Waivers & Adds', nC), tab('trades', 'Trades', nT));
}
function txParts() {
    const tx = S.ui.tx, w = tx.tab === 'waivers', cur = w ? tx.part : tx.tpart;
    const runs = waiverRuns(), newest = runs.length ? runs[0].at : 0, dot = w && !!newest && newest > (tx.seenBefore || 0);
    if (w && cur === 'history' && newest) txMarkSeen(newest);   // the dot and the NEW tag stay for this visit
    const n = { claims: claimGroups().length, offers: myTrades().length, review: reviewTrades().length }, warn = w && claimItems().some(it => liveWarn(it));
    return h('div', { class: 'txparts', role: 'tablist' }, ...txPartList(tx.tab).map(([k, label]) => h('button', { class: cur === k ? 'on' : '', role: 'tab', 'aria-selected': String(cur === k), 'data-part': k,
        onclick: () => { if (w) tx.part = k; else tx.tpart = k; render(); } }, label, n[k] ? h('i', null, n[k]) : null,
        k === 'claims' && warn ? h('span', { class: 'txwtab', title: 'One of your claims fails in some outcome' }, warnIcon()) : null,
        k === 'history' && dot ? h('b', { class: 'txdot', title: 'A waiver run was processed since you last looked' }) : null)));
}
// the mark on a claim that fails in some outcome, always beside words that say why
const warnIcon = () => sv('svg', { class: 'txwi', viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true' },
    sv('path', { d: 'M8 1.6 15.2 14.2H.8z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }),
    sv('path', { d: 'M8 6.2v3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' }),
    sv('circle', { cx: 8, cy: 11.9, r: 1, fill: 'currentColor' }));
function txPinned() {
    const tx = S.ui.tx, my = S.myRoster, wi = waiverInfo();
    if (tx.tab === 'trades') {
        const st = S.league.settings || {}, dl = st.trade_deadline, rv = st.trade_review_days;
        return [h('button', { class: 'txprop', type: 'button', 'data-act': 'trade-new', onclick: () => openTrade(null) }, h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Propose a trade with…', caret()),
            h('div', { class: 'txmeans' }, dl && dl <= LAST_WEEK ? ['deadline ', h('b', null, `week ${dl}`)] : 'no trade deadline', rv ? ` · ${rv}-day league review` : '')];
    }
    const open = openRosterSlots();
    return [h('div', { class: 'search txsearch' }, '🔍', h('input', { placeholder: 'Add a player: type a name', value: tx.q || '', 'data-focus': 'tx-search', 'aria-label': 'Search available players',
            oninput: (e) => { tx.q = e.target.value; if (tx.q.trim().length >= 2) tx.part = 'ideas'; render(); } })),
        h('div', { class: 'txmeans' }, wi.faab ? [h('b', null, `$${faabLeft(my)}`), ' FAAB left · '] : `priority #${my.settings.waiver_position} · `, h('b', { class: 't' }, open), ` open spot${open === 1 ? '' : 's'} · runs ${runsWhen()}`)];
}

// ── your claims, as you think of them ──
// Sleeper holds one claim per drop. Here a claim is a player: his bid, and the
// drops it will try in order (the first is the plain claim, the rest are its
// back-ups). They are read back in the order Sleeper tries them.
const TX_SECOND = () => `badgerTxSecond-${S.leagueId}`, TX_QUIET = () => `badgerTxQuiet-${S.leagueId}`;
function txLinks() { try { return JSON.parse(localStorage.getItem(TX_SECOND()) || '{}') || {}; } catch (e) { return {}; } }
function txSetLink(pid, first) { try { const l = txLinks(); if (first) l[pid] = first; else delete l[pid]; localStorage.setItem(TX_SECOND(), JSON.stringify(l)); } catch (e) { /* private window: the link is not kept */ } }
function txQuiet() { try { return JSON.parse(localStorage.getItem(TX_QUIET()) || '[]') || []; } catch (e) { return []; } }
function txHush(key) { try { localStorage.setItem(TX_QUIET(), JSON.stringify([...new Set([...txQuiet(), key])].slice(-40))); } catch (e) { /* asked again next time */ } }
const txBidMin = () => Math.max(0, (S.league.settings || {}).waiver_bid_min || 0);
function groupClaims(claims, links) {
    const ordered = claims.map(t => Object.assign(claimKey(t), { t })).sort(byClaimKey).map(r => r.t), by = new Map();
    for (const t of ordered) {
        const pid = Object.keys(t.adds || {})[0]; if (!pid) continue;
        const b = (t.settings || {}).waiver_bid || 0, d = Object.keys(t.drops || {})[0] || '';
        let g = by.get(pid); if (!g) by.set(pid, g = { pid, bid: b, bids: [], claims: [], drops: [] });
        // a lower bid on the same player is a back-up bid: it is tried when the bigger one cannot be paid
        g.claims.push(t); if (!g.bids.includes(b)) g.bids.push(b); if (!g.drops.includes(d)) g.drops.push(d);
        // each claim is one try: this bid with this drop. A back-up is a pair of its own, never every bid with every drop
        if (!g.pairs) g.pairs = []; if (!g.pairs.some(x => x.b === b && x.d === d)) g.pairs.push({ b, d });
    }
    const groups = [...by.values()];
    // a second choice (a link kept in this browser) holds only while both claims drop the same player
    for (const g of groups) { const a = (links || {})[g.pid], first = a && by.get(a); g.secondOf = first && first.drops[0] && first.drops[0] === g.drops[0] && !(links || {})[a] ? a : null; }
    return groups;
}
const claimGroups = () => groupClaims(myClaims(), txLinks());
// what "What will happen" says about the claims filed now, and the warnings you have not set aside
const claimItems = () => { const gs = claimGroups(); return gs.length ? claimStory(gs, openRosterSlots(), { faab: !!waiverInfo().faab, left: faabLeft(S.myRoster), name: lastNm }) : []; };
const warnKey = (it) => `${it.warn}:${it.g ? it.g.pid : ''}:${it.g ? it.g.drops.join(',') : ''}:${it.g && it.g.bids ? it.g.bids.join(',') : ''}`;
const liveWarn = (it) => !!it.warn && !txQuiet().includes(warnKey(it));
// What your claims will do, in sentences. Pure: `groups` are your claims in the
// order Sleeper tries them ({ pid, bid, bids, drops, pairs, secondOf }: `pairs` its claims,
// each a bid and a drop; without them every bid goes with every drop), `open` your open
// roster spots, `o.left` your FAAB. Every combination of each player being there
// to be had, or taken by someone else, is played the way Sleeper plays a run: your
// claims bigger bid first, then in your order; a claim it cannot pay for fails, as
// does one with no room or with a drop an earlier claim already used. Each item is
// { say, warn: 'cash' | 'room' | 'drop' | null, g, cause, flag, fix }: a warning is
// a claim that fails in some outcome, `cause` the claims above it that make it
// fail, `flag` the few words its row shows, `fix` the back-up bid that would cure
// a 'cash' one (what you would have left).
function claimStory(groups, open, o) {
    const nm = o.name, out = [], B = (pid) => ({ b: nm(pid) }), G = groups.slice(0, 10), n = G.length;
    const list = (gs) => gs.flatMap((g, i) => [i ? (i === gs.length - 1 ? ' and ' : ', ') : '', B(g.pid)]);
    const names = (gs) => gs.map(g => nm(g.pid)).join(gs.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1');
    const orList = (gs) => gs.flatMap((g, i) => [i ? (i === gs.length - 1 ? ' or ' : ', ') : '', B(g.pid)]), orNames = (gs) => gs.map(g => nm(g.pid)).join(', ').replace(/, ([^,]*)$/, ' or $1');
    const come = (gs) => (gs.length === 1 ? ' comes in' : gs.length === 2 ? ' both come in' : ' all come in');
    const hits = (gs) => (gs.length === 1 ? ' hits' : ' hit');
    const bidsOf = (g) => (g.bids && g.bids.length ? g.bids : [g.bid || 0]);
    const win = (g, b) => (o.faab && b > 0 ? [`If your $${b} wins `, B(g.pid)] : ['If you get ', B(g.pid)]);
    const tries = [];
    const pairsOf = (g) => (g.pairs && g.pairs.length ? g.pairs : bidsOf(g).flatMap(b => g.drops.map(d => ({ b, d }))));
    G.forEach((g, gi) => pairsOf(g).forEach((x, k) => tries.push({ gi, b: x.b, d: x.d, k })));
    tries.sort((x, y) => y.b - x.b || x.gi - y.gi || x.k - y.k);
    const runs = [];
    for (let m = 0; m < (1 << n); m++) {
        let cash = o.faab ? o.left : Infinity, spots = open;
        const gone = new Set(), got = new Map(), why = new Map(), had = new Map(), lost = new Map();
        for (const t of tries) {
            if (got.has(t.gi) || !((m >> t.gi) & 1)) continue;
            // everything that stops this try, not only the first thing met: no money AND no open spot is told as both
            const short = t.b > cash ? ['cash'] : [];
            if (t.d ? gone.has(t.d) : spots <= 0) short.push(t.d ? 'drop' : 'room');
            if (short.length) { why.set(t.gi, short); if (short[0] === 'cash') had.set(t.gi, cash); if (t.d && gone.has(t.d)) lost.set(t.gi, t.d); continue; }
            if (t.d) gone.add(t.d); else spots--;
            cash -= t.b; got.set(t.gi, { b: t.b, d: t.d });
        }
        runs.push({ m, got, why, had, lost, spent: o.faab ? o.left - cash : 0 });
    }
    // the claims above one, in every run of `rs`
    const above = (rs, gi) => G.slice(0, gi).filter((x, xi) => rs.length && rs.every(r => r.got.has(xi)));
    const sure = []; let plain = true;
    const flush = () => { if (!sure.length) return; const k = sure.length;
        out.push({ say: [...list(sure), k === 1 ? ' goes into an open spot.' : ` go into ${k === open ? 'your ' + (NUMW[k] || k) : (NUMW[k] || k) + ' of your ' + (NUMW[open] || open)} open spots.`], sure: true }); sure.length = 0; };
    G.forEach((g, gi) => {
        if (g.secondOf) return;   // told with its first choice
        const si = G.findIndex(x => x.secondOf === g.pid);
        if (si >= 0) {
            const s = G[si], base = g.drops[0];
            flush(); plain = false;
            out.push({ say: [...win(g, bidsOf(g)[0]), ', ', B(base), ' is dropped for him and ', B(s.pid), ' is not claimed.'] });
            out.push({ say: ['If you miss ', B(g.pid), ', ', B(s.pid), o.faab ? ` is claimed for $${bidsOf(s)[0]} and ` : ' is claimed and ', B(base), ' is dropped for him instead.'] });
            return;
        }
        const mine = runs.filter(r => (r.m >> gi) & 1), fails = mine.filter(r => !r.got.has(gi)), first = { b: pairsOf(g)[0].b, d: pairsOf(g)[0].d || '' };
        if (fails.length) {
            const main = (r) => { const w = r.why.get(gi); return w[w.length - 1]; };   // 'room' or 'drop' when either stops it, else 'cash'
            const count = {}; for (const r of fails) { const k = main(r); count[k] = (count[k] || 0) + 1; }
            const kind = Object.keys(count).sort((a, b) => count[b] - count[a])[0], rs = fails.filter(r => main(r) === kind), lostD = kind === 'drop' ? rs[0].lost.get(gi) : null;
            const broke = kind !== 'cash' && rs.every(r => r.why.get(gi)[0] === 'cash'), have = Math.max(0, Math.min(...rs.map(r => r.had.get(gi) || 0)));
            // a claim above is a cause only by doing the thing that hurts: spending money, taking a spot, dropping the same man
            const role = (x) => (kind === 'cash' ? x.b > 0 : kind === 'room' ? !x.d : x.d === lostD);
            const C = G.slice(0, gi).filter((x, xi) => rs.every(r => r.got.has(xi) && (kind === 'drop' || role(r.got.get(xi)))));
            // no one claim above causes it in every case: then any of the ones that can, "Etienne or Bernard"
            const any = C.length ? [] : G.slice(0, gi).filter((x, xi) => rs.some(r => r.got.has(xi) && role(r.got.get(xi))) && !mine.every(r => r.got.has(xi))), by = C.length ? C : any;
            const ifIn = C.length ? ['If ', ...list(C), come(C)] : ['If ', ...orList(any), ' comes in'], flagIf = C.length ? `${names(C)}${hits(C)}` : `${orNames(any)} hits`;
            flush(); plain = false;
            // when the money is short as well, the fix for a spot or a drop carries a back-up bid of what is left (`fix`)
            const tooBroke = !broke ? [] : first.b > o.left ? [` His $${first.b} is more than your $${o.left} too.`] : by.length ? [` That leaves you $${have} too, short of his $${first.b}.`] : [' Your other claims could spend the money for him too.'];
            if (kind === 'cash') {
                out.push({ warn: 'cash', g, cause: by, fix: have, flag: first.b > o.left ? 'more than you have' : by.length ? `fails if ${flagIf}` : 'fails if the money runs out',
                    say: first.b > o.left ? [B(g.pid), `’s $${first.b} is more than your $${o.left}, so his claim fails.`]
                        : by.length ? [...ifIn, ` you have $${have} left, so `, B(g.pid), `’s $${first.b} claim cannot be paid, and it fails.`]
                        : ['If your other claims spend your money first, ', B(g.pid), `’s $${first.b} claim cannot be paid.`] });
            } else if (kind === 'room') {
                const takes = C.length === 1 ? (open === 1 ? ', he takes your only open spot' : ', he takes your last open spot') : open === C.length ? `, they take your ${NUMW[open] || open} open spots` : ', they take the open spots that are left';
                out.push({ warn: 'room', g, cause: by, flag: by.length ? `no open spot if ${flagIf}` : 'no open spot', fix: broke ? have : undefined, broke,
                    say: [...(C.length ? [B(g.pid), ' comes in only if ', ...(C.length === 1 ? [B(C[0].pid), ' misses'] : [C.length === 2 ? 'either of them misses' : 'one of them misses']), '. If ', ...list(C), come(C), takes, ', so there is none left for ', B(g.pid), ', and his claim fails.']
                        : any.length ? [...ifIn, ', that takes your last open spot, so there is none left for ', B(g.pid), ', and his claim fails.']
                        : ['You have no open spot, so ', B(g.pid), '’s claim fails as it stands.']), ...tooBroke] });
            } else {
                const d = lostD;
                out.push({ warn: 'drop', g, cause: by, flag: by.length ? `fails if ${flagIf}` : `${nm(d)} is already gone`, fix: broke ? have : undefined, broke,
                    say: [...(by.length ? (d === (g.drops[0] || '') ? [B(g.pid), ' drops ', B(d), ' too. ', ...ifIn, ', ', B(d), ' is already gone and ', B(g.pid), '’s claim fails.']
                        : [B(g.pid), ' drops ', B(d), ' too when there is no open spot. ', ...ifIn, ', ', B(d), ' is already gone and his claim fails.'])
                        : [B(d), ' is no longer yours to drop, so ', B(g.pid), '’s claim fails.']), ...tooBroke] });
            }
            return;
        }
        // he comes in whenever he is there to be had; say how, and what decides it
        const ways = new Set(mine.map(r => { const x = r.got.get(gi); return `${x.b}|${x.d}`; }));
        if (ways.size === 1) {
            const x = mine[0].got.get(gi);
            if (!x.d && x.b === first.b) { sure.push(g); return; }
            flush(); plain = false;
            out.push({ say: x.d ? [...win(g, x.b), ', ', B(x.d), ' is dropped for him.'] : [B(g.pid), ` goes into an open spot at $${x.b}.`] });
            return;
        }
        flush(); plain = false;
        const alt = mine.filter(r => { const x = r.got.get(gi); return x.b !== first.b || x.d !== first.d; }), C = above(alt, gi), ax = alt[0].got.get(gi);
        // who brings the other way about: the claims above that come in every time it happens ("Perine and Tracy both"), else any
        // claim above that can, by taking the open spot or spending the money ("Perine or Tracy")
        const spotOrCash = ax.d !== first.d && ax.b !== first.b ? (x) => !x.d || x.b > 0 : ax.d !== first.d ? (x) => !x.d : (x) => x.b > 0;
        const any = C.length ? [] : G.slice(0, gi).filter((x, xi) => alt.some(r => r.got.has(xi) && spotOrCash(r.got.get(xi))) && !mine.every(r => r.got.has(xi)));
        const ifC = C.length ? ['If ', ...list(C), come(C), ', '] : any.length ? ['If ', ...orList(any), ' comes in, '] : null;
        if (ax.b !== first.b && ax.d === first.d) out.push({ say: [...(ifC || ['If the money runs short, ']), B(g.pid), ' is claimed at ', { am: `$${ax.b}` }, ax.d ? [' and ', B(ax.d), ' is dropped for him'] : ' and goes into an open spot', '. ',
            ...(C.length === 1 ? ['If you miss ', B(C[0].pid), ', ', B(g.pid), ` is claimed at $${first.b}.`] : [`Otherwise he is claimed at $${first.b}.`])].flat() });
        else if (ax.b !== first.b && ax.d !== first.d) out.push({ say: [...(ifC || ['If the money and the open spots run short, ']), B(g.pid), ' is claimed at ', { am: `$${ax.b}` }, ax.d ? [' and ', B(ax.d), ' is dropped for him'] : ' and goes into an open spot', '. ',
            ...(C.length === 1 ? ['If you miss ', B(C[0].pid), ', ', B(g.pid), first.d ? [` is claimed at $${first.b} and `, B(first.d), ' is dropped for him.'] : ` goes into an open spot at $${first.b}.`] : [`Otherwise he is claimed at $${first.b}.`])].flat() });
        else if (!first.d && ax.d) out.push({ say: [B(g.pid), ' takes an open spot if one is left. ', ...(ifC || ['If none is, ']), B(ax.d), ' is dropped for him.'] });
        else if (first.d && ax.d) out.push({ say: [...win(g, first.b), ', ', B(first.d), ' is dropped for him. If ', B(first.d), ' has already gone, ', B(ax.d), ' is dropped instead.'] });
        else out.push({ say: [B(g.pid), ' comes in either way. How depends on the claims above him.'] });
    });
    flush();
    if (plain && out.length === 1) out[0].say.push(' Nobody is dropped.');
    if (o.faab && n) out.push({ say: ['The most this can spend is ', { am: `$${Math.max(0, ...runs.map(r => r.spent))}` }, ` of your $${o.left}.`] });
    return out;
}
// One waiver run as it went for one team, a player at a time. Sleeper records a
// result per claim; the claims were made to get players, so that is how it is
// told. A claim that failed on a player the team won anyway was a back-up that
// was not needed, never "outbid".
function runStory(txns, me) {
    const mine = txns.filter(t => (t.roster_ids || []).includes(me)), by = new Map();
    for (const t of mine) { const pid = Object.keys(t.adds || {})[0]; if (!pid) continue; if (!by.has(pid)) by.set(pid, []); by.get(pid).push(t); }
    const bidOf = (t) => (t.settings || {}).waiver_bid || 0, rows = [];
    for (const [pid, ts] of by) {
        const won = ts.find(t => t.status === 'complete'), bid = Math.max(...ts.map(bidOf));
        const taker = txns.find(t => t.status === 'complete' && !(t.roster_ids || []).includes(me) && (t.adds || {})[pid] != null);
        const note = ts.map(t => (t.metadata || {}).notes || '').find(Boolean) || '';
        rows.push(won ? { pid, res: 'won', bid: bidOf(won), drop: Object.keys(won.drops || {})[0] || null }
            : taker ? { pid, res: 'outbid', bid, to: (taker.roster_ids || [])[0], price: (taker.settings || {}).waiver_bid }
            : /too many players/i.test(note) ? { pid, res: 'room', bid } : { pid, res: 'missed', bid, note });
    }
    rows.sort((a, b) => (b.res === 'won') - (a.res === 'won') || b.bid - a.bid);
    const got = rows.filter(r => r.res === 'won');
    return { rows, claims: mine.length, got: got.length, spent: got.reduce((s, r) => s + r.bid, 0) };
}
function openTx(o) {
    if (!S.myRoster) { toast('You do not manage a team in this league', 'err'); return; }
    S.ui.chat = false; S.ui.notes = false; S.ui.composer = null; S.ui.trade = null;
    const toYou = myTrades().some(t => tradeRole(t) === 'toyou');
    S.ui.tx = Object.assign({ tab: toYou ? 'trades' : 'waivers', part: 'claims', tpart: 'offers', view: 'list', from: 'list', seenBefore: txSeenAt() }, o || {});
    txLoad(); render();
}
function closeTx() { S.ui.tx = null; S.ui.composer = null; S.ui.trade = null; render(); }
// "+ Claim" or "+ Add": the player's row opens with his bid and who is dropped.
// Nothing is sent until the button in the row is pressed.
function newPick(pid, waiv, drop, where) {
    return { pid, waiv: !!waiv, where: where || 'top', bid: waiv && waiverInfo().faab ? Math.min(faabLeft(S.myRoster), txBidMin()) : 0, backs: [],
        drops: [drop != null ? drop : openRosterSlots() > 0 ? '' : ((suggestDrop(pid) || {}).pid || '')], cond: false, more: false, adding: false };
}
// From anywhere on the page: the drawer opens on Ideas with that player on top.
function openComposer(pid, waiv, drop) {
    if (!S.myRoster) return;
    const was = S.ui.tx;
    S.ui.chat = false; S.ui.notes = false;
    S.ui.tx = Object.assign({ seenBefore: txSeenAt(), tpart: 'offers', from: 'list' }, was || {}, { tab: 'waivers', part: 'ideas', view: 'list', edit: null, pick: newPick(pid, waiv, drop, 'top') });
    if (waiv && waiverInfo().faab) loadPriceHistory();
    txLoad(); render();
}
function txBack(to) { const tx = S.ui.tx; S.ui.composer = null; S.ui.trade = null; if (!tx) return render(); if (to === 'page') return closeTx(); tx.view = to || 'list'; render(); }

// ── the writes behind a claim ──
// Claims in the order they should be tried. Sleeper sorts by bid first, so only
// claims at the same bid can be put in an order, and only then is anything sent.
async function keepClaimOrder(wanted) {
    for (const [t, place] of claimOrderWrites(wanted)) Object.assign(t, await setClaimSettings(t, claimSettings(t, { priority: place })) || {});
}
// Sleeper cannot change the drop on a filed claim: update_waiver_claim takes the
// bid and the claim order and nothing else (its server refuses a drops argument,
// asked 2026-10-13, and its own app has no such edit). So a changed drop is a
// claim filed and a claim withdrawn.
// A claim made to hold `want`: its bid, and a Sleeper claim for each drop in
// order. What is already filed is kept, what is missing is filed FIRST, and only
// then is what is no longer wanted withdrawn: if Sleeper refuses a new one, the
// claims you had still stand. `all` is every group, for the order.
async function applyGroup(g, want) {
    const my = S.myRoster, pairs = want.pairs, keep = [], slot = []; let sent = 0;
    const dropOf = (t) => Object.keys(t.drops || {})[0] || '', bidOf = (t) => (t.settings || {}).waiver_bid || 0;
    try {
        // the claim already filed for this drop at this bid stays as it is; one for this drop at another bid has its bid moved;
        // Sleeper cannot change a filed claim's drop, so a new drop is a new claim
        pairs.forEach((x, i) => { const t = g.claims.find(c => !keep.includes(c) && dropOf(c) === x.d && bidOf(c) === x.b); if (t) { keep.push(t); slot[i] = t; } });
        for (let i = 0; i < pairs.length; i++) { if (slot[i]) continue; const t = g.claims.find(c => !keep.includes(c) && dropOf(c) === pairs[i].d && !pairs.some(x => x.d === dropOf(c) && x.b === bidOf(c)));
            if (t) { keep.push(t); Object.assign(t, await updateClaim(t, pairs[i].b) || {}); sent++; slot[i] = t; } }
        for (let i = 0; i < pairs.length; i++) if (!slot[i]) { slot[i] = await submitClaim({ [g.pid]: my.roster_id }, pairs[i].d ? { [pairs[i].d]: my.roster_id } : {}, pairs[i].b); sent++; }
        for (const t of g.claims) if (!keep.includes(t)) { await cancelClaim(t); sent++; }
    } catch (e) { throw new Error(`${e.message || e} ${sent ? 'Part of your change went through: the list shows where things stand.' : 'Your claims stand as they were.'}`); }
    return slot;
}
// blocks of claims ({ ts }) in your order of players; Sleeper still takes the bigger
// bid first, and a back-up bid sits with its player among the claims at its bid
const orderBlocks = (blocks) => keepClaimOrder(blocks.flatMap((b, gi) => b.ts.map((t, ti) => ({ t, gi, ti, bid: (t.settings || {}).waiver_bid || 0 }))).sort((x, y) => y.bid - x.bid || x.gi - y.gi || x.ti - y.ti).map(x => x.t));
async function saveClaimGroup(g, want, all) {
    const line = await applyGroup(g, want);
    await orderBlocks((all || [g]).map(x => ({ ts: x.pid === g.pid ? line : x.claims })));
}
async function txWrite(fn, okText) {
    const tx = S.ui.tx; if (!tx || tx.busy) return false;
    tx.busy = true; render(); let ok = true;
    try { await fn(); if (okText) toast(okText, 'ok'); } catch (e) { ok = false; console.error(TAG, e); toast(String(e.message || e), 'err'); }
    try { await refreshAfterAction(); if (await tidyOrder()) await refreshAfterAction(); } catch (e) { console.error(TAG, e); }
    if (S.ui.tx) S.ui.tx.busy = false; render(); return ok;
}
// After any write: each player's claims tried together in your order, his back-up
// bid among the claims at that bid. Sends nothing when Sleeper's order already agrees.
async function tidyOrder() {
    const gs = claimGroups(); if (gs.length < 2) return 0;
    const wanted = gs.flatMap((g, gi) => g.claims.map((t, ti) => ({ t, gi, ti, bid: (t.settings || {}).waiver_bid || 0 }))).sort((x, y) => y.bid - x.bid || x.gi - y.gi || x.ti - y.ti).map(x => x.t);
    const w = claimOrderWrites(wanted);
    for (const [t, place] of w) await setClaimSettings(t, claimSettings(t, { priority: place }));
    return w.length;
}
function filePick(pk) {
    const tx = S.ui.tx, my = S.myRoster, drops = editDrops(pk);
    return txWrite(async () => {
        if (pk.waiv) { let first = null; for (const x of editPairs(pk)) { const t = await submitClaim({ [pk.pid]: my.roster_id }, x.d ? { [x.d]: my.roster_id } : {}, x.b); first = first || t; }
            Object.assign(tx, { pick: null, q: '', part: 'claims', justFiled: first ? first.transaction_id : null }); }
        else { await addDrop({ [pk.pid]: my.roster_id }, drops[0] ? { [drops[0]]: my.roster_id } : {}); Object.assign(tx, { pick: null, q: '' }); }
    }, pk.waiv ? `Claim filed · ${pname(pk.pid)}` : `${pname(pk.pid)} added`);
}
function openEdit(g, second, more) {
    const tx = S.ui.tx, r = pairRules(g);
    tx.pick = null;
    tx.edit = Object.assign({ pid: g.pid, bid: r.bid, backs: r.backs, drops: r.drops, dbids: r.dbids, second: second ? second.pid : null, cond: r.drops.length > 1 || r.backs.length > 0 || !!second, more: false, adding: false }, more || {});
    render();
}
// A group's claims as the editor's rules: the first pair is the claim; a pair with another drop is "no spot is open (or the
// last drop has gone) → drop him, and bid this"; a pair with the same drop and less money is "I can't pay → bid this".
function pairRules(g) {
    const ps = g.pairs && g.pairs.length ? g.pairs : (g.bids || [g.bid]).flatMap(b => g.drops.map(d => ({ b, d }))), top = ps[0] || { b: g.bid || 0, d: '' };
    const r = { bid: top.b, drops: [top.d], dbids: [], backs: [] };
    for (const x of ps.slice(1)) { if (x.d === top.d) r.backs.push(x.b); else { r.drops.push(x.d); r.dbids.push(x.b === top.b ? null : x.b); } }
    return r;
}
// …and back: the claims the rules file, biggest bid first, each rule's own bid with its own drop. A back-up drop's bid is
// the claim's own unless you set one (never above it: Sleeper would try it first). A drop not picked yet files nothing.
function editPairs(ed) {
    const out = [], add = (b, d) => { if (!out.some(x => x.b === b && x.d === d)) out.push({ b, d }); }, d0 = ed.drops[0] || '';
    add(ed.bid, d0);
    ed.drops.slice(1).forEach((d, i) => { if (d) add(Math.min(ed.bid, ((ed.dbids || [])[i] ?? ed.bid)), d); });
    (ed.backs || []).forEach(b => { if (b != null && b < ed.bid) add(b, d0); });
    return out.map((x, i) => [x, i]).sort((a, b) => b[0].b - a[0].b || a[1] - b[1]).map(x => x[0]);
}
const editDrops = (ed) => [...new Set(ed.drops)].filter((d, i) => i === 0 || d);
// the bids a claim will try, biggest first: its bid, then each back-up bid below it
const editBids = (ed) => [...new Set(editPairs(ed).map(x => x.b))];
// a rule added but not filled in: a back-up drop or a second choice with nobody picked yet
const editEmpty = (ed) => !!ed && (ed.drops.slice(1).some(d => !d) || ed.second === '');
const pairsKey = (ps) => (ps || []).map(x => `${x.b}|${x.d}`).sort().join(',');   // the same claims, whatever order Sleeper lists them in
const claimDirty = (g, second, ed) => pairsKey(editPairs(ed)) !== pairsKey(g.pairs) || (ed.second || null) !== (second ? second.pid : null);
function saveEdit(g, second) {
    const tx = S.ui.tx, ed = tx.edit, groups = claimGroups(), drops = editDrops(ed), other = ed.second ? groups.find(x => x.pid === ed.second) : null;
    if (editEmpty(ed)) return toast('Pick a player for the condition you added, or remove it.', 'err');
    if (other && !drops[0]) return toast('Pick who both claims drop. Sleeper only stops at one when they drop the same player.', 'err');
    if (other && other.bid > ed.bid) return toast(`Sleeper tries the bigger bid first, so ${lastNm(other.pid)} at $${other.bid} would be tried before ${lastNm(g.pid)}. Lower his bid, or raise this one.`, 'err');
    return txWrite(async () => {
        const mine = await applyGroup(g, { pairs: editPairs(ed) });
        // a second choice takes this claim's drop, and is tried straight after it
        const his = other ? (other.drops.join() !== drops[0] ? await applyGroup(other, { pairs: (other.bids || [other.bid]).map(b => ({ b, d: drops[0] })) }) : other.claims) : null;
        const blocks = [];
        for (const x of groups) { if (other && x.pid === other.pid) continue; blocks.push({ ts: x.pid === g.pid ? mine : x.claims }); if (x.pid === g.pid && other) blocks.push({ ts: his }); }
        await orderBlocks(blocks);
        if (other) txSetLink(other.pid, g.pid);
        if (second && (!other || other.pid !== second.pid)) txSetLink(second.pid, null);
        tx.edit = null;
    }, 'Claim saved');
}
// Swap a claim with its neighbour at the same bid. Sleeper takes the bigger bid
// first, so equal bids are the only ones an order changes; it is sent at once.
function moveClaim(firsts, i, j, groups) {
    const order = firsts.slice(); [order[i], order[j]] = [order[j], order[i]];
    const blocks = [];
    for (const g of order) { blocks.push({ ts: g.claims }); for (const x of groups) if (x.secondOf === g.pid) blocks.push({ ts: x.claims }); }
    return txWrite(() => orderBlocks(blocks), `${lastNm(firsts[i].pid)} is now tried ${j < i ? 'before' : 'after'} ${lastNm(firsts[j].pid)}`);
}
function cancelGroup(g, second) {
    return txWrite(async () => { for (const t of g.claims) await cancelClaim(t); txSetLink(g.pid, null); if (second) txSetLink(second.pid, null); S.ui.tx.edit = null; }, 'Claim cancelled');
}

// ── the fields a claim is made of ──
// Who to drop: your whole roster, fewest rest-of-season points first (the user's order, 2026-10-13). Not the
// bench first: a star on bye sits on the bench for a week, and that list led with Chase and Burrow. `hole` marks a
// man whose drop would leave a lineup spot of his position empty (not when the claim is for his position): he stays
// in the menu, but is never one of the quick picks.
function dropCands(forPid) {
    const my = S.myRoster, mine = (my.players || []).filter(p => !(my.reserve || []).includes(p) && !(my.taxi || []).includes(p));
    const slots = {}, have = {};
    for (const s of rosterPositions()) slots[s] = (slots[s] || 0) + 1;
    for (const p of mine) have[ppos(p)] = (have[ppos(p)] || 0) + 1;
    return mine.map(pid => { const pos = ppos(pid);
        return { pid, pos, ros: txRos(pid), rk: rosRank(pid), hole: (!forPid || ppos(forPid) !== pos) && have[pos] - 1 < (slots[pos] || 0) };
    }).sort((a, b) => (a.ros || 0) - (b.ros || 0));
}
function bidField(o, pid, key) {
    const max = faabLeft(S.myRoster), mk = S.histReady ? marketRead(ppos(pid)) : null, rv = rivalBidders(ppos(pid));
    const set = (v) => { o.bid = Math.max(txBidMin(), Math.min(max, Math.round(v) || 0)); render(); };
    return h('div', { class: 'txfl' }, h('span', { class: 'lab' }, 'BID'), h('div', { class: 'fx' },
        h('span', { class: 'txstep' }, h('button', { type: 'button', title: 'Bid one dollar less', 'aria-label': 'Bid one dollar less', onclick: () => set((o.bid || 0) - 1) }, '−'),
            h('span', { class: 'cur' }, '$'), h('input', { type: 'number', min: txBidMin(), max, value: o.bid, 'data-act': 'claim-bid', 'data-focus': key, 'aria-label': 'Your bid in dollars', oninput: (e) => { o.bid = Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0))); render(); } }),
            h('button', { type: 'button', title: 'Bid one dollar more', 'aria-label': 'Bid one dollar more', onclick: () => set((o.bid || 0) + 1) }, '+')),
        h('span', { class: 'shm' }, `of your $${max}`),
        h('span', { class: 'shm txmkt', title: 'What has won at this position in this league, and who else has a hole there' },
            mk && mk.lo != null ? `${posLabel(ppos(pid))} has gone for $${mk.lo}${mk.hi !== mk.lo ? `–$${mk.hi}` : ''} here · ` : '', rv.needers.length ? `${rv.needers.length} other team${rv.needers.length === 1 ? ' is' : 's are'} short at ${posLabel(ppos(pid))}` : `nobody else is short at ${posLabel(ppos(pid))}`)));
}
function dropSel(o, i) {
    const used = new Set(o.drops.filter((d, j) => j !== i && d)), cands = dropCands(o.pid).filter(c => !used.has(c.pid)), cur = o.drops[i] || '';
    const wk = txWeek();
    const op = (c) => { const bye = byeWeekOf((P(c.pid) || {}).team), w = txWk(c.pid);
        return h('option', { value: c.pid, selected: cur === c.pid }, [posLabel(c.pos), pname(c.pid), statusOf(c.pid), bye ? `bye ${bye}` : null,
            bye === wk ? `wk ${wk} bye` : `wk ${wk} ${w == null ? '—' : fmt1(w)}`, c.ros == null ? 'no projection' : `RoS ${fmt0(c.ros)}${c.rk ? ` (${posLabel(c.pos)}${c.rk})` : ''}`].filter(Boolean).join(' · ')); };
    return h('select', { class: 'sel txsel', 'data-act': 'drop-sel', 'aria-label': i ? 'Who is dropped instead' : 'Who is dropped for him', onchange: (e) => { o.drops[i] = e.target.value; render(); } },
        i === 0 ? h('option', { value: '', selected: cur === '' }, openRosterSlots() > 0 ? 'nobody: use an open spot' : 'pick a player') : (cur ? null : h('option', { value: '', selected: true }, 'pick a player')),
        ...cands.map(op));
}
function dropField(o, pid) {
    const open = openRosterSlots(), cur = o.drops[0] || '', quick = dropCands(pid).filter(c => !c.hole).slice(0, 2).map(c => c.pid);
    const shown = [...new Set([...(open > 0 || cur === '' ? [''] : []), ...quick, ...(cur ? [cur] : [])])];
    const opt = (d) => h('button', { class: `txopt${cur === d ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(cur === d), 'data-drop': d, disabled: !d && open <= 0, title: !d && open <= 0 ? 'Your roster is full: someone has to be dropped' : null,
        onclick: () => { o.drops[0] = d; render(); } }, d ? [shortName(d), h('em', { title: 'Rest of season, Sleeper’s projection' }, `RoS ${fmt0(txRos(d))}`)] : 'Nobody: open spot');
    return h('div', { class: 'txfl' }, h('span', { class: 'lab' }, 'DROP'), h('div', { class: 'fx', role: 'radiogroup', 'aria-label': 'Who is dropped for him' }, ...shown.map(opt),
        o.more ? [dropSel(o, 0), h('button', { class: 'lnk', type: 'button', 'data-act': 'tx-cut-vs', onclick: () => { const tx = S.ui.tx; tx.vs = pid; tx.view = 'cut'; render(); } }, 'compare with your roster')]
            : h('button', { class: 'lnk', type: 'button', 'data-act': 'drop-more', 'aria-expanded': 'false', onclick: () => { o.more = true; render(); } }, 'someone else', foldCaret(false))));
}
// a condition under its claim; × takes it out (in the claim's Edit, so Save confirms it)
// the condition and what it does wrap together; the × stays at the line's top right
const ifLine = (cond, then, rm) => h('div', { class: 'txif' }, h('span', { class: 'ifk' }, 'IF'), h('span', { class: 'ifb' }, h('span', null, cond), h('span', { class: 'ifa', 'aria-hidden': 'true' }, '→'), h('span', { class: 'ift' }, then)),
    rm ? h('button', { class: 'txifx', type: 'button', 'data-act': 'if-remove', title: 'Take this condition out', 'aria-label': 'Take this condition out', onclick: rm }, '×') : null);
const ruleTx = (cond, then, rm) => h('div', { class: 'txrule' }, h('div', null, h('span', { class: 'ifk' }, 'IF'), h('span', { class: 'ifc' }, cond), rm ? h('button', { class: 'lnk', type: 'button', 'data-act': 'rule-remove', onclick: rm }, 'remove') : null),
    h('div', null, h('span', { class: 'thk' }, 'THEN'), then));
// the rules on a claim, and the ones that can still be added to it
function rulesTx(o, groups) {
    const kids = [ruleTx('I win him', ['drop ', dropSel(o, 0)])];
    const faab = waiverInfo().faab && o.waiv !== false;
    for (let i = 1; i < o.drops.length; i++) { const b = Math.min(o.bid, ((o.dbids || [])[i - 1] ?? o.bid));
        // "IF no spot is open THEN drop [him] and bid [this]": one claim, its own drop and its own bid
        kids.push(ruleTx(o.drops[i - 1] && o.drops[i - 1] === o.drops[i] ? `I can’t pay $${o.bid} by then` : o.drops[i - 1] ? `${lastNm(o.drops[i - 1])} has already gone` : 'no spot is open by then',
            ['drop ', dropSel(o, i), faab ? h('span', { class: 'andbid' }, 'and bid ', h('select', { class: 'sel txsel', 'data-act': 'dropbid-sel', 'aria-label': 'What this claim bids', onchange: (e) => { const v = Number(e.target.value); o.dbids = o.dbids || []; o.dbids[i - 1] = v === o.bid ? null : v; render(); } },
                ...Array.from({ length: Math.max(0, o.bid) + 1 }, (_, v) => o.bid - v).map(v => h('option', { value: v, selected: v === b }, `$${v}`)))) : null],
            () => { o.drops.splice(i, 1); if (o.dbids) o.dbids.splice(i - 1, 1); render(); })); }
    (o.backs || []).forEach((b, i) => {
        const prev = i ? o.backs[i - 1] : o.bid, max = Math.max(0, prev - 1);
        kids.push(ruleTx(b === 0 ? 'I’m out of FAAB by then' : `I can’t pay $${prev} by then`, ['bid ', h('select', { class: 'sel txsel', 'data-act': 'backbid-sel', 'aria-label': 'Your back-up bid', onchange: (e) => { o.backs[i] = Number(e.target.value); render(); } },
            ...Array.from({ length: max + 1 }, (_, v) => h('option', { value: v, selected: v === b }, `$${v}`))), ' instead'], () => { o.backs.splice(i, 1); render(); }));
    });
    if (o.second != null) {
        const others = (groups || []).filter(x => (x.pid !== o.pid && !x.secondOf) || x.pid === o.second);
        kids.push(ruleTx('I don’t get him', ['add ', h('select', { class: 'sel txsel', 'data-act': 'second-sel', 'aria-label': 'Who you go after instead', onchange: (e) => { o.second = e.target.value; render(); } },
            o.second ? null : h('option', { value: '', selected: true }, 'pick one of your claims'), ...others.map(x => h('option', { value: x.pid, selected: o.second === x.pid }, `${pname(x.pid)}${waiverInfo().faab ? ` · $${x.bid}` : ''}`))), ' instead'], () => { o.second = null; render(); }));
        kids.push(h('div', { class: 'txnote' }, 'Sleeper only stops at one when both claims drop the same player, so the second choice takes this claim’s drop.'));
    }
    return kids;
}
function condMenu(o, groups) {
    const last = o.drops[o.drops.length - 1] || '', items = [];
    const add = (label, fn, off) => items.push(h('button', { class: 'txmi', type: 'button', disabled: !!off, title: off || null, onclick: () => { fn(); o.cond = true; o.adding = false; render(); } }, ...label));
    const IF = (t) => [h('span', { class: 'ifk' }, 'IF'), ` ${t} `, h('span', { class: 'thk' }, 'THEN')];
    // the player is chosen by you: the new rule opens with nobody in it
    add([...IF(last ? `${lastNm(last)} has already gone` : 'no spot is open by then'), last ? ' drop someone else' : ' drop someone', waiverInfo().faab && o.waiv !== false ? ' and bid' : ''], () => { o.drops.push(''); (o.dbids = o.dbids || []).push(null); });
    if (waiverInfo().faab && o.waiv !== false) { const lowest = (o.backs || []).length ? o.backs[o.backs.length - 1] : o.bid;
        add([...IF(lowest > 0 && !(o.backs || []).length ? 'I’m out of FAAB by then' : `I can’t pay $${lowest} by then`), ' bid less'], () => { o.backs = [...(o.backs || []), 0]; }, lowest > 0 ? null : 'There is nothing below a $0 bid'); }
    if (groups && o.second == null) { const k = groups.filter(x => x.pid !== o.pid && !x.secondOf).length;
        add([...IF('I don’t get him'), ' go after someone else'], () => { o.second = ''; if (!o.drops[0]) o.drops[0] = ''; }, k ? null : 'Claim the other player first, then name him here'); }
    return h('div', { class: 'txmenu', role: 'menu' }, h('div', { class: 'mh' }, `Add a condition to ${lastNm(o.pid)}’s claim`), ...items);
}

// ── Claims ──
function claimRowTx(g, n, groups, items, move) {
    const tx = S.ui.tx, wi = waiverInfo(), ed = tx.edit && tx.edit.pid === g.pid ? tx.edit : null, second = groups.find(x => x.secondOf === g.pid) || null;
    const dirty = !!ed && claimDirty(g, second, ed), empty = editEmpty(ed), id = g.claims[0].transaction_id, fresh = tx.justFiled && g.claims.some(t => String(t.transaction_id) === String(tx.justFiled));
    const it = !ed ? (items || []).find(x => x.g && x.g.pid === g.pid && liveWarn(x)) : null;
    const dropEl = (d) => (d ? [h('span', { class: 'dir out' }, 'DROP'), ' ', h('b', null, pname(d))] : 'no drop · uses an open spot');
    // the fix, inside the flag: a back-up bid is filed at once; a drop is yours to choose
    const R = pairRules(g), ps = g.pairs || [];
    // a back-up bid for every drop the claim already has, so the money case is covered whichever drop is in play
    const withBid = (b) => [...ps, ...[...new Set(ps.map(x => x.d))].map(d => ({ b, d }))].filter((x, i, a) => a.findIndex(y => y.b === x.b && y.d === x.d) === i).map((x, i) => [x, i]).sort((a, c) => c[0].b - a[0].b || a[1] - c[1]).map(x => x[0]);
    const fix = !it ? null : it.warn === 'cash'
        ? h('button', { class: 'btn xs p', type: 'button', 'data-act': 'flag-bid', 'data-txn': id, disabled: !!tx.busy, onclick: () => txWrite(() => saveClaimGroup(g, { pairs: withBid(it.fix) }, groups), `${lastNm(g.pid)}: a $${it.fix} back-up bid is filed`) }, `Bid $${it.fix} then`)
        // no spot (or the drop gone) and the money spent too: the drop is yours to pick, the back-up bid comes with it, both one condition's worth
        : h('button', { class: 'btn xs p', type: 'button', 'data-act': 'flag-choose', 'data-txn': id, onclick: () => openEdit(g, second, { cond: true, drops: [...R.drops, ''], dbids: [...R.dbids, it.broke ? it.fix : null] }) },
            it.warn === 'room' ? (it.broke ? `Choose a drop and bid $${it.fix}` : 'Choose a drop for that case') : it.broke ? `Choose a back-up drop and bid $${it.fix}` : 'Choose a back-up drop');
    const row = h('div', { class: `txcl${ed ? ' open' : ''}${fresh ? ' txfresh' : ''}${it ? ' wr' : ''}`, 'data-claim': id, 'data-pid': g.pid, 'data-warn': it ? it.warn : null },
        h('span', { class: 'ordc' }, move && move.up ? h('button', { class: 'txord', type: 'button', 'data-act': 'claim-up', 'data-txn': id, title: `Try ${lastNm(g.pid)} earlier`, 'aria-label': `Try ${lastNm(g.pid)} earlier`, disabled: !!tx.busy, onclick: move.up }, '▲') : null,
            h('span', { class: 'ord', title: `Tried ${ordinal(n)}` }, n),
            move && move.down ? h('button', { class: 'txord', type: 'button', 'data-act': 'claim-down', 'data-txn': id, title: `Try ${lastNm(g.pid)} later`, 'aria-label': `Try ${lastNm(g.pid)} later`, disabled: !!tx.busy, onclick: move.down }, '▼') : null),
        h('img', { class: 'hs', src: headshot(g.pid), alt: '', loading: 'lazy', onerror: hideBroken }),
        h('div', { class: 'txw' }, h('div', { class: 'txl1' }, h('span', { class: 'dir in' }, 'ADD'), nameLine(g.pid, true)), h('div', { class: 'txl2' }, dropEl(ed ? editDrops(ed)[0] : g.drops[0]), fresh ? [' · ', h('b', { class: 'txjust' }, 'just filed')] : null),
            it ? h('div', { class: 'txl3' }, h('span', { class: 'wf' }, warnIcon(), it.flag), fix) : null),
        wi.faab ? h('span', { class: 'txbidc' }, `$${ed ? ed.bid : g.bid}`) : h('span'),
        h('button', { class: `btn sm ${dirty || empty ? 'p' : 's'}`, type: 'button', 'data-act': ed ? (dirty || empty ? 'claim-save' : 'claim-done') : 'claim-edit', 'data-txn': id, disabled: !!tx.busy || empty, title: empty ? 'Pick a player for the condition you added first' : null,
            onclick: () => (ed ? (dirty ? saveEdit(g, second) : (tx.edit = null, render())) : openEdit(g, second)) }, ed ? (dirty || empty ? (tx.busy ? 'Saving…' : 'Save') : 'Done') : 'Edit'));
    if (!ed) {
        const out = (more) => () => openEdit(g, second, Object.assign({ cond: true }, more));
        // each back-up is one claim, said the way its rule reads: "IF no spot is open → DROP Vidal and BID $0"
        const bidEl = (b) => [h('span', { class: 'thk' }, 'BID'), ' ', h('b', { class: 'am' }, `$${b}`)];
        const ifs = R.drops.slice(1).map((d, i) => { const b = R.dbids[i] ?? R.bid;
            return ifLine(R.drops[i] && R.drops[i] === d ? `I can’t pay $${R.bid} by then` : R.drops[i] ? `${lastNm(R.drops[i])} has already gone` : 'no spot is open', [dropEl(d), b !== R.bid && wi.faab ? [' and ', ...bidEl(b)] : null],
                out({ drops: R.drops.filter((x, j) => j !== i + 1), dbids: R.dbids.filter((x, j) => j !== i) })); });
        R.backs.forEach((b, i) => ifs.push(ifLine(b === 0 && !i ? 'I’m out of FAAB by then' : `I can’t pay $${i ? R.backs[i - 1] : R.bid} by then`, [...bidEl(b), ' instead'], out({ backs: R.backs.filter((x, j) => j !== i) }))));
        if (second) ifs.push(ifLine('I don’t get him', [h('span', { class: 'dir in' }, 'ADD'), ' ', h('b', null, pname(second.pid)), wi.faab ? ` for $${second.bid}` : '', ' instead, same drop'], out({ second: null })));
        return [row, ...ifs];
    }
    const refile = editDrops(ed).join() !== g.drops.join();
    return [row, h('div', { class: 'txed' },
        wi.faab ? bidField(ed, g.pid, 'tx-editbid') : null,
        ed.cond ? rulesTx(ed, groups) : dropField(ed, g.pid),
        h('div', { class: 'txedf' }, h('button', { class: 'btn sm danger', type: 'button', 'data-act': 'claim-cancel', 'data-txn': id, disabled: !!tx.busy, onclick: () => cancelGroup(g, second) }, 'Cancel claim'),
            h('button', { class: 'lnk', type: 'button', 'data-act': 'claim-cond', 'aria-expanded': String(!!ed.adding), onclick: () => { ed.adding = !ed.adding; render(); } }, ed.cond ? '+ another condition' : '+ Add a condition')),
        ed.adding ? condMenu(ed, groups) : null,
        refile ? h('div', { class: 'txnote' }, 'Sleeper cannot change the drop on a filed claim, so saving files it again and withdraws the old one. Its place among your claims is kept.') : null)];
}
function txStory(groups, items) {
    const say = (parts) => parts.map(p => (typeof p === 'string' ? p : p.b != null ? h('b', null, p.b) : h('b', { class: 'am' }, p.am)));
    return [h('div', { class: 'txsech' }, h('b', null, 'What will happen')), h('ul', { class: 'txwill', 'data-story': '1' }, ...items.map(it => {
        if (!it.warn) return h('li', null, say(it.say));
        const g = it.g, hushed = !liveWarn(it), links = [];
        // the fix sits on the claim's row; here, only what else you can say about it
        if (!hushed && it.warn === 'drop' && g && it.cause && it.cause.length === 1 && it.cause[0].drops[0] === g.drops[0] && g.drops.length === 1) {
            const a = it.cause[0];
            links.push(h('button', { class: 'lnk', type: 'button', 'data-act': 'story-onlyone', onclick: () => { if (g.bid > a.bid) return toast(`Sleeper tries the bigger bid first, so ${lastNm(g.pid)} at $${g.bid} would be tried before ${lastNm(a.pid)}. Lower his bid first.`, 'err'); txSetLink(g.pid, a.pid); render(); } }, 'I only want one of them'));
        }
        if (!hushed && g) links.push(h('button', { class: 'lnk', type: 'button', 'data-act': 'story-leave', onclick: () => { txHush(warnKey(it)); render(); } }, 'Leave it'));
        return h('li', { 'data-warn': it.warn }, flagEl('warn', 'HEADS UP'), say(it.say), links.length ? [' ', ...links.flatMap((l, i) => (i ? [' · ', l] : [l]))] : null);
    }))];
}
function txClaims() {
    const tx = S.ui.tx, my = S.myRoster, wi = waiverInfo(), groups = claimGroups(), out = [];
    if (!groups.length) out.push(txEmpty(`No claims filed. Claims run ${runsWhen()}. Type a name in the search box, or look under Ideas.`));
    else {
        const items = claimStory(groups, openRosterSlots(), { faab: !!wi.faab, left: faabLeft(my), name: lastNm });
        out.push(h('div', { class: 'txsech' }, h('b', null, 'Your claims'), h('span', { class: 'shm' }, 'tried top to bottom')));
        const firsts = groups.filter(g => !g.secondOf);
        firsts.forEach((g, i) => out.push(...claimRowTx(g, i + 1, groups, items, {
            up: i > 0 && firsts[i - 1].bid === g.bid ? () => moveClaim(firsts, i, i - 1, groups) : null,
            down: i < firsts.length - 1 && firsts[i + 1].bid === g.bid ? () => moveClaim(firsts, i, i + 1, groups) : null })));
        out.push(...txStory(groups, items));
    }
    const last = waiverRuns().find(r => r.txns.some(t => (t.roster_ids || []).includes(my.roster_id)));
    if (last) { const st = runStory(last.txns, my.roster_id);
        out.push(h('button', { class: 'txfold', type: 'button', 'data-act': 'tx-lastrun', title: 'How your last run went, in History', onclick: () => { Object.assign(tx, { part: 'history', hkind: 'waivers', hwho: 'yours' }); render(); } },
            h('span', { class: 'txk' }, 'LAST RUN'), h('span', { class: 'txft' }, `${runDay(last.at)} · got `, h('b', null, `${st.got} of ${st.rows.length}`), wi.faab ? ` · spent $${st.spent}` : ''), h('span', { class: 'lnk' }, 'History', foldCaret(false)))); }
    return out;
}

// ── Ideas: who is worth a look, and the row that makes the claim ──
function pickPanel(pk) {
    const tx = S.ui.tx, wi = waiverInfo(), open = openRosterSlots(), groups = claimGroups(), kids = [];
    if (pk.waiv && wi.faab) kids.push(bidField(pk, pk.pid, 'tx-bid'));
    else if (pk.waiv) kids.push(h('div', { class: 'txfl' }, h('span', { class: 'lab' }, 'ORDER'), h('div', { class: 'fx shm' }, `Waiver priority #${S.myRoster.settings.waiver_position} · claims run ${runsWhen()}`)));
    kids.push(pk.cond ? rulesTx(pk, null) : dropField(pk, pk.pid));
    // what this claim would run into among the ones already filed, said before it is filed
    if (pk.waiv && !editEmpty(pk)) {
        const me = { pid: pk.pid, bid: pk.bid, bids: editBids(pk), drops: editDrops(pk), pairs: editPairs(pk), secondOf: null };
        const it = claimStory([...groups.filter(g => g.pid !== pk.pid), me], open, { faab: !!wi.faab, left: faabLeft(S.myRoster), name: lastNm }).find(x => x.warn && x.g === me);
        if (it) kids.push(h('div', { class: 'txsugl' }, h('span', { class: 'wf' }, warnIcon()), it.say.map(p => (typeof p === 'string' ? p : p.b != null ? h('b', null, p.b) : p.am)),
            h('div', { class: 'txsug' }, it.warn === 'cash'
                ? h('button', { class: 'btn sm s', type: 'button', 'data-act': 'pick-backbid', onclick: () => { pk.backs = [...(pk.backs || []), it.fix]; pk.cond = true; render(); } }, `Also bid $${it.fix} for that case`)
                : h('button', { class: 'btn sm s', type: 'button', 'data-act': 'pick-choose', onclick: () => { pk.drops.push(''); (pk.dbids = pk.dbids || []).push(it.broke ? it.fix : null); pk.cond = true; render(); } },
                    `${it.warn === 'room' ? 'Choose a drop' : 'Choose a back-up drop'}${it.broke ? ` and bid $${it.fix}` : ''} for that case`))));
    }
    const needs = !pk.drops[0] && open <= 0, empty = editEmpty(pk), bids = editBids(pk);
    kids.push(h('div', { class: 'txedf' }, h('button', { class: 'btn p', type: 'button', 'data-act': 'composer-submit', disabled: needs || empty || !!tx.busy, title: needs ? 'Your roster is full: pick who is dropped' : empty ? 'Pick a player for the condition you added first' : null, onclick: () => filePick(pk) },
            tx.busy ? 'Sending…' : pk.waiv ? `File claim${wi.faab ? ` · $${bids.join(', then $')}` : ''}` : 'Add now'),
        pk.waiv ? h('button', { class: 'lnk', type: 'button', 'data-act': 'claim-cond', 'aria-expanded': String(!!pk.adding), onclick: () => { pk.adding = !pk.adding; render(); } }, pk.cond ? '+ another condition' : '+ Add a condition')
            : h('span', { class: 'shm' }, 'He joins your team at once.')));
    if (pk.adding) kids.push(condMenu(pk, null));
    if (needs) kids.push(h('div', { class: 'txnote' }, 'Your roster is full, so someone has to be dropped for him.'));
    return h('div', { class: 'txed txpick', 'data-pick': pk.pid }, ...kids);
}
function ideaRow(pid, where, o) {
    o = o || {};
    const tx = S.ui.tx, pk = tx.pick, open = !!pk && pk.pid === pid && pk.where === where, waiv = onWaiversNow(pid), has = claimGroups().some(g => g.pid === pid);
    const btn = open ? h('button', { class: 'lnk', type: 'button', 'data-act': 'pick-close', 'aria-expanded': 'true', onclick: () => { tx.pick = null; render(); } }, 'close', foldCaret(true))
        : has ? h('button', { class: 'txtag', type: 'button', title: 'You have a claim on him: see Claims', onclick: () => { tx.part = 'claims'; render(); } }, 'claimed')
        : h('button', { class: `btn sm ${waiv ? 'warn' : 'p'}`, type: 'button', 'data-act': waiv ? 'claim' : 'add', disabled: !S.myRoster,
            onclick: (e) => { e.stopPropagation(); tx.pick = newPick(pid, waiv, o.drop, where); tx.edit = null; if (waiv && waiverInfo().faab) loadPriceHistory(); render(); } }, waiv ? '+ Claim' : '+ Add');
    const row = txRow(pid, { cls: `btns${open ? ' txopen' : ''}`, sub: o.sub, noOpp: o.noOpp, btn, attrs: { 'data-idea': pid, 'data-where': where } });
    return open ? [row, pickPanel(pk)] : [row];
}
function txIdeas() {
    const tx = S.ui.tx, wk = txWeek(), out = [];
    if (!S.proj[wk]) loadProj(wk).then(render).catch(() => {});
    const pos = tx.pos || 'ALL', q = (tx.q || '').trim().toLowerCase();
    const okPos = (pid) => pos === 'ALL' || ppos(pid) === pos;
    const rostered = rosteredSet(), avail = (pid) => !rostered.has(pid) && !!P(pid) && POS_ORDER.includes(ppos(pid));
    const sub = (pid) => (onWaiversNow(pid) ? h('span', { class: 'amber' }, clearsLabel(pid)) : 'free agent');
    const byProj = (a, b) => (projOf(b, wk) || 0) - (projOf(a, wk) || 0);
    const pk = tx.pick;
    if (pk && pk.where === 'top') out.push(txHead('Your pick', null, { btns: true }), ...ideaRow(pk.pid, 'top', { sub: sub(pk.pid) }));
    out.push(h('div', { class: 'txchips', role: 'group', 'aria-label': 'Position' }, ...['ALL', ...POS_ORDER].map(p => h('button', { class: pos === p ? 'on' : '', type: 'button', 'aria-pressed': pos === p ? 'true' : 'false', onclick: () => { tx.pos = p; render(); } }, p === 'ALL' ? 'All' : posLabel(p)))));
    if (q.length >= 2) {
        const hits = Object.keys(S.proj[wk] || {}).filter(pid => avail(pid) && okPos(pid) && pname(pid).toLowerCase().includes(q)).sort(byProj).slice(0, 25);
        out.push(txHead(`${hits.length} available`, `matching “${tx.q.trim()}”`, { btns: true }), ...hits.flatMap(pid => ideaRow(pid, 'find', { sub: sub(pid) })));
        if (!hits.length) out.push(txEmpty(`No available player matches “${tx.q.trim()}”. Rostered players are left out.`));
        out.push(h('button', { class: 'txmore', type: 'button', 'data-act': 'tx-clear', onclick: () => { tx.q = ''; render(); } }, 'Clear the search'));
        return out;
    }
    // upgrades over your own roster, by rest of season
    const b = cutBoard();
    if (!b) out.push(txHead('Upgrades', 'rest of season', { cols: false }), txEmpty('Reading Sleeper’s rest-of-season projections…'));
    else {
        // cutting an IR player frees no bench spot, and an Out one is in the projection already
        const ups = b.rows.filter(r => r.up && r.slot !== 'IR' && !r.out && okPos(r.fa)).sort((x, y) => y.gain - x.gain);
        out.push(txHead('Upgrades', 'rest of season', { btns: true }));
        if (!ups.length) out.push(txEmpty(`Nobody available projects ${CUT_GAIN} more the rest of the way than a receiver, back or tight end you roster.`));
        const seen = new Set();
        for (const r of ups) { if (seen.has(r.fa) || seen.size >= 3) continue; seen.add(r.fa);
            out.push(...ideaRow(r.fa, 'up', { noOpp: true, drop: openRosterSlots() > 0 ? '' : r.pid, sub: [h('span', { class: 'delta up' }, `+${fmt0(r.gain)}`), ` over ${pname(r.pid)}`] }).map((el, i) => (i ? el : (el.setAttribute('data-upgrade', r.pid), el)))); }
        out.push(h('button', { class: 'txmore', type: 'button', 'data-act': 'tx-cut', onclick: () => { tx.vs = null; tx.view = 'cut'; render(); } }, 'Your whole roster against waivers ›'));
    }
    const jd = justDropped().filter(x => okPos(x.pid)).slice(0, 5);
    if (jd.length) out.push(txHead('Just dropped', 'on waivers now', { btns: true }), ...jd.flatMap(x => ideaRow(x.pid, 'jd', { noOpp: true, sub: h('span', { title: `Dropped by ${teamName(rosterById(x.rid))}` }, h('span', { class: 'amber' }, clearsLabel(x.pid)), ` · dropped ${DAY[new Date(x.at).getDay()]}`) })));
    const tr = Object.entries(S.trending || {}).filter(([pid, v]) => v.add && avail(pid) && okPos(pid)).sort((a, c) => c[1].add - a[1].add).slice(0, 5);
    out.push(txHead('Most added', 'all Sleeper leagues, 24h', { btns: true }));
    if (tr.length) out.push(...tr.flatMap(([pid, v]) => ideaRow(pid, 'tr', { noOpp: true, sub: [h('span', { class: 'up' }, `▲ ${kAdds(v.add)}`), ' adds'] })));
    else out.push(txEmpty(S.trending ? 'Nobody trending is available here.' : 'Reading Sleeper’s adds…'));
    // Not free agents only: between the last game and the run, everyone unrostered
    // is claim-only, and filtering those out left this list empty for two days.
    const best = Object.keys(S.proj[wk] || {}).filter(pid => avail(pid) && okPos(pid) && !alreadyPlayed(pid, wk)).sort(byProj).slice(0, 5);
    out.push(txHead('Best this week', `by week ${wk} projection`, { btns: true }));
    if (best.length) out.push(...best.flatMap(pid => ideaRow(pid, 'best', {})));
    else out.push(txEmpty(`Nobody left to pick up for week ${wk}.`));
    out.push(h('div', { class: 'txfoot2' }, 'Every player, with filters and stats: ', h('button', { class: 'lnk', type: 'button', onclick: () => { closeTx(); go('players'); } }, 'Players page ›')));
    return out;
}

// ── History: what is settled, the league's or yours ──
function runMine(r, open) {
    const tx = S.ui.tx, my = S.myRoster, wi = waiverInfo(), st = runStory(r.txns, my.roster_id), key = String(r.at), isNew = tx.seenBefore ? r.at > tx.seenBefore : false;
    const B = (pid) => h('b', null, lastNm(pid)), team = (rid) => teamName(rosterById(rid));
    const gotTxt = st.rows.filter(x => x.res === 'won').map(x => `${shortName(x.pid)}${wi.faab ? ` $${x.bid}` : ''}`).join(', ');
    if (!open) return h('button', { class: 'txfold', type: 'button', 'data-run': key, 'aria-expanded': 'false', onclick: () => { tx.openRuns = Object.assign({}, tx.openRuns, { [key]: true }); render(); } },
        h('span', { class: 'txk' }, runDay(r.at).replace(/^\w+ /, '').toUpperCase()), h('span', { class: 'txft' }, 'got ', h('b', null, `${st.got} of ${st.rows.length}`), gotTxt ? ` · ${gotTxt}` : ''), h('span', { class: 'lnk' }, 'show', foldCaret(false)));
    const hap = (x) => {
        const say = x.res === 'won' ? [B(x.pid), ` came in${wi.faab ? ` for $${x.bid}` : ''}`, x.drop ? ['. ', h('b', null, pname(x.drop)), ' was dropped for him.'] : ', into your open spot.']
            : x.res === 'outbid' ? [B(x.pid), ' went to ', team(x.to), wi.faab && x.price != null ? ` for $${x.price}. You bid $${x.bid}.` : '. They were ahead of you in the waiver order.']
            : x.res === 'room' ? [B(x.pid), ' had no room: your roster was full when his claim came up.']
            : [B(x.pid), ' was not claimed. ', x.note || ''];
        const word = x.res === 'won' ? 'WON' : x.res === 'outbid' ? (wi.faab ? 'OUTBID' : 'MISSED') : x.res === 'room' ? 'NO ROOM' : 'MISSED';
        return h('div', { class: 'txhap', 'data-res': x.res }, h('img', { class: 'hs', src: headshot(x.pid), alt: '', loading: 'lazy', onerror: hideBroken }), h('div', { class: 'say' }, say), h('span', { class: `txres ${x.res}` }, word));
    };
    return h('div', { class: `txrb${isNew ? ' new' : ''}`, 'data-run': key },
        h('div', { class: 'txrbh' }, h('span', { class: 'txk' }, 'WAIVERS'), h('b', null, runDay(r.at)), isNew ? h('span', { class: 'txnew' }, 'NEW') : null, h('span', { class: 'shm' }, `got ${st.got} of ${st.rows.length}${wi.faab ? ` · spent $${st.spent}` : ''}`)),
        h('div', { class: 'txhapt' }, 'What happened'), ...st.rows.map(hap),
        st.claims > st.rows.length ? h('div', { class: 'txrbf' }, `Sleeper tried ${st.claims} claims of yours to get there: ${st.claims - st.rows.length} were back-ups it did not need, or had no room.`) : null);
}
function runLeague(r, open) {
    const tx = S.ui.tx, me = S.myRoster.roster_id, faab = waiverInfo().faab, key = String(r.at), isNew = tx.seenBefore ? r.at > tx.seenBefore : false;
    const bidOf = (t) => (t.settings || {}).waiver_bid, who = (rid) => (rid === me ? 'you' : teamName(rosterById(rid)));
    const won = r.txns.filter(t => t.status === 'complete').sort((a, b) => (bidOf(b) || 0) - (bidOf(a) || 0) || ((a.settings || {}).seq || 0) - ((b.settings || {}).seq || 0));
    const lost = r.txns.filter(t => t.status !== 'complete');
    if (!open) { const top = won[0], tp = top && Object.keys(top.adds || {})[0];
        return h('button', { class: 'txfold', type: 'button', 'data-run': key, 'aria-expanded': 'false', onclick: () => { tx.openRuns = Object.assign({}, tx.openRuns, { [key]: true }); render(); } },
            h('span', { class: 'txk' }, runDay(r.at).replace(/^\w+ /, '').toUpperCase()), h('span', { class: 'txft' }, won.length === 1 && tp ? [`${shortName(tp)} to ${who((top.roster_ids || [])[0])}`, faab && bidOf(top) != null ? [' · ', h('b', null, `$${bidOf(top)}`)] : ''] : `${won.length} players · ${r.txns.length} claims`), h('span', { class: 'lnk' }, 'show', foldCaret(false))); }
    const all = !!(tx.wideRuns && tx.wideRuns[key]), shown = all || won.length <= 7 ? won : won.slice(0, 6);
    const row = (t) => {
        const rid = (t.roster_ids || [])[0], pid = Object.keys(t.adds || {})[0], others = lost.filter(x => (x.adds || {})[pid] != null && (x.roster_ids || [])[0] !== rid);
        const teams = new Set(others.map(x => (x.roster_ids || [])[0])), next = others.length ? Math.max(...others.map(x => bidOf(x) || 0)) : null, mine = others.filter(x => (x.roster_ids || [])[0] === me);
        const note = !others.length ? 'nobody else bid' : [faab ? `next best $${next}` : `${teams.size} other${teams.size === 1 ? '' : 's'} claimed`, mine.length && faab ? ` · you bid $${Math.max(...mine.map(x => bidOf(x) || 0))}` : faab && teams.size > 1 ? ` · ${teams.size} others bid` : ''];
        return h('div', { class: 'txwon', 'data-won': pid }, h('img', { class: 'hs', src: headshot(pid), alt: '', loading: 'lazy', onerror: hideBroken }),
            h('div', { class: 'txw' }, nameLine(pid, true), h('div', { class: 'txl2' }, 'to ', h('b', { class: rid === me ? 'me' : '' }, who(rid)), ' · ', note)), faab && bidOf(t) != null ? h('span', { class: 'txbidc' }, `$${bidOf(t)}`) : h('span'));
    };
    return h('div', { class: `txrb${isNew ? ' new' : ''}`, 'data-run': key },
        h('div', { class: 'txrbh' }, h('span', { class: 'txk' }, 'WAIVERS'), h('b', null, runDay(r.at)), isNew ? h('span', { class: 'txnew' }, 'NEW') : null, h('span', { class: 'shm' }, `${won.length} player${won.length === 1 ? '' : 's'} · ${r.txns.length} claim${r.txns.length === 1 ? '' : 's'}`)),
        ...shown.map(row),
        shown.length < won.length ? h('button', { class: 'txrbf txrbm', type: 'button', onclick: () => { tx.wideRuns = Object.assign({}, tx.wideRuns, { [key]: true }); render(); } }, `${won.length - shown.length} more${faab ? `, down to $${bidOf(won[won.length - 1]) || 0}` : ''}`, h('span', { class: 'lnk' }, 'show', foldCaret(false))) : null);
}
function moveRowTx(t, league) {
    const me = S.myRoster.roster_id, rid = (t.roster_ids || [])[0], adds = Object.keys(t.adds || {}), drops = Object.keys(t.drops || {}), at = t.status_updated || t.created;
    const when = Date.now() - at < 20 * 3600e3 && new Date(at).getDate() === new Date().getDate() ? 'today' : runDay(at);
    return h('div', { class: 'txmv', 'data-move': t.transaction_id }, h('img', { class: 'hs', src: headshot(adds[0] || drops[0]), alt: '', loading: 'lazy', onerror: hideBroken }),
        h('div', { class: 'txw' }, league ? h('div', { class: 'txl2' }, h('b', { class: rid === me ? 'me' : '' }, rid === me ? `${teamName(rosterById(rid))} (you)` : teamName(rosterById(rid)))) : null,
            ...adds.map(p => h('div', { class: 'txl1' }, h('span', { class: 'dir in' }, 'ADD'), nameLine(p, true))), ...drops.map(p => h('div', { class: 'txl1' }, h('span', { class: 'dir out' }, 'DROP'), nameLine(p, true)))),
        h('span', { class: 'txwhen', title: new Date(at).toLocaleString() }, when));
}
function spendFold() {
    const tx = S.ui.tx, my = S.myRoster, me = my.roster_id, budget = (S.league.settings || {}).waiver_budget || 0, rows = [];
    for (let w = 1; w <= Math.max(1, S.curWeek); w++) for (const t of S.txns[w] || []) if (t.type === 'waiver' && t.status === 'complete' && (t.roster_ids || []).includes(me) && (t.settings || {}).waiver_bid > 0) rows.push({ pid: Object.keys(t.adds || {})[0], bid: t.settings.waiver_bid });
    rows.sort((a, b) => b.bid - a.bid);
    const used = budget - faabLeft(my), max = rows.length ? rows[0].bid : 1;
    return [h('button', { class: 'txfold', type: 'button', 'data-act': 'tx-spend', 'aria-expanded': String(!!tx.spend), onclick: () => { tx.spend = !tx.spend; render(); } }, h('span', { class: 'txk' }, 'FAAB'), h('span', { class: 'txft' }, h('b', null, `$${used}`), ` of $${budget} spent`), h('span', { class: 'lnk' }, 'on whom', foldCaret(!!tx.spend))),
        tx.spend ? h('div', { class: 'txspend' }, ...(rows.length ? rows.map(x => h('div', null, h('span', null, shortName(x.pid)), h('i', { style: `width:${Math.max(3, x.bid / max * 100)}%` }), h('b', null, `$${x.bid}`))) : [txEmpty('Nothing spent on a claim that went through.')])) : null];
}
function txHistory() {
    const tx = S.ui.tx, me = S.myRoster.roster_id, wi = waiverInfo(), kind = tx.hkind || 'all', yours = tx.hwho === 'yours', out = [];
    out.push(h('div', { class: 'txplrow' }, pills([['all', 'All'], ['waivers', 'Waivers'], ['fa', 'Free agents']], kind, (k) => { tx.hkind = k; tx.hN = 0; render(); }, 'Kind of move'),
        pills([['league', 'League'], ['yours', 'Yours']], yours ? 'yours' : 'league', (k) => { tx.hwho = k; tx.hN = 0; render(); }, 'Whose moves')));
    if (yours && wi.faab && kind !== 'fa') out.push(...spendFold());
    const runs = kind === 'fa' ? [] : waiverRuns().filter(r => !yours || r.txns.some(t => (t.roster_ids || []).includes(me))), moves = [];
    if (kind !== 'waivers') for (let w = 1; w <= Math.max(1, S.curWeek); w++) for (const t of S.txns[w] || []) if (t.type === 'free_agent' && t.status === 'complete' && (!yours || (t.roster_ids || []).includes(me))) moves.push(t);
    const items = [...runs.map(r => ({ at: r.at, run: r })), ...moves.map(t => ({ at: t.status_updated || t.created, move: t }))].sort((a, b) => b.at - a.at);
    if (!items.length) out.push(txEmpty(S.txLoading ? 'Reading the league’s moves…' : yours ? 'Nothing of yours yet this season.' : 'Nothing in this league yet this season.'));
    const n = tx.hN || 14; let firstRun = true;
    for (const it of items.slice(0, n)) {
        if (it.move) { out.push(moveRowTx(it.move, !yours)); continue; }
        const open = firstRun || !!(tx.openRuns && tx.openRuns[String(it.run.at)]); firstRun = false;
        out.push(yours ? runMine(it.run, open) : runLeague(it.run, open));
    }
    if (items.length > n) out.push(h('button', { class: 'txmore', type: 'button', onclick: () => { tx.hN = n + 14; render(); } }, 'Earlier'));
    return out;
}

// ── Trades: offers in flight, and the ones that went through ──
function txOffers() {
    const tx = S.ui.tx, ts = myTrades(), by = { toyou: [], sent: [], review: [] };
    for (const t of ts) by[tradeRole(t)].push(t);
    if (!ts.length) { const dl = (S.league.settings || {}).trade_deadline; return [txEmpty(`No offers either way.${dl && dl <= LAST_WEEK ? ` The deadline is week ${dl}.` : ''}`)]; }
    return [h('div', { class: 'txcols' }, h('span'), h('span', { class: 'txc' }, `WK ${txWeek()}`), h('span', { class: 'txc' }, 'RoS')), ...[...by.toyou, ...by.sent, ...by.review].map(tradeCardTx)];
}
// ── Trades › Ideas: the season played player by player ───────────────────────
// (the user, 2026-10-25: "trades that help win, which sometimes means big swings rather than margin increases in
// average points".) The playoff odds play a team's week as one number whose spread depends only on its projected
// total, so a steady player and a boom-or-bust one with the same projection look alike there. Ideas need the
// difference, so here each player's week is drawn:
//  - his Sleeper projection times a ratio drawn from what actually happened to projections at his position this
//    season (every player-week projected at 3 or more), the spread widened or narrowed by his own record, shrunk
//    toward his position's until he has games behind him;
//  - every team starts its best projected lineup, as a manager would, and only starters count;
//  - the regular season plays out on the real schedule, seeded by the same rules as the playoff odds, and the
//    bracket plays to a champion, so title odds come with it;
//  - a trade is replayed on the same draws (a draw is a hash of season, week and player), so the difference is the
//    trade and not the luck of a different run.
// Each idea is judged by what it does to each side's chance of the playoffs and of the title. A team's own goal is
// read from where it stands: a contender plays for the title, everyone else for a playoff spot.
const TS_N = 2000, TS_N2 = 10000, TS_POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
// Before there are games to learn from: actual over projected at each position, 10th / 50th / 90th percentile, as
// Sleeper's projections did through week 6 of 2026.
const TS_FALLBACK = { QB: [0.47, 0.96, 1.68], RB: [0.18, 0.74, 1.85], WR: [0.13, 0.79, 2.08], TE: [0, 0.66, 2.34], K: [0.44, 0.99, 1.84], DEF: [0.33, 1.55, 3.22] };
const tsYield = () => new Promise((res) => setTimeout(res, 0));
async function tsPools() {
    const cur = Math.max(1, S.curWeek), key = `tspools:${S.leagueId}:${S.season}:${cur}`;
    if (S.tsPools && S.tsPools.key === key) return S.tsPools;
    let rec = await idbGet(key);
    if (!rec) {
        const pool = Object.fromEntries(TS_POS.map((p) => [p, []])), own = {}, qs = TS_POS.map((p) => `&position[]=${p}`).join('');
        for (let w = 1; w < cur; w++) {
            const [pr, st] = await Promise.all([rest(weekProjUrl(w)).catch(() => []), rest(`${API2}/stats/nfl/${S.season}/${w}?season_type=regular${qs}`).catch(() => [])]);
            const act = {}; for (const x of st) act[x.player_id] = x.stats || {};
            for (const x of pr) {
                const pid = String(x.player_id), p = ppos(pid), pj = scoreStats(x.stats), a = act[pid], got = a ? scoreStats(a) || 0 : 0;
                if (!pool[p] || !(pj >= 3) || !a || (!a.gp && !a.gms_active && !got)) continue;   // no line, or a line for a game he sat out
                const r = Math.max(0, got / pj); pool[p].push(r); (own[pid] = own[pid] || []).push(r);
            }
        }
        rec = { key, pool, own };
        if (cur > 1) idbSet(key, rec);
    }
    // a position with too little behind it (week 1 or 2) borrows the shape above
    for (const p of TS_POS) {
        if (rec.pool[p].length >= 40) { rec.pool[p].sort((x, y) => x - y); continue; }
        const [a, m, b] = TS_FALLBACK[p], out = [];
        for (let i = 0; i <= 100; i++) { const u = i / 100; out.push(u <= 0.1 ? a * u / 0.1 : u <= 0.5 ? a + (m - a) * (u - 0.1) / 0.4 : u <= 0.9 ? m + (b - m) * (u - 0.5) / 0.4 : b * (1 + (u - 0.9) * 3)); }
        rec.pool[p] = out;
    }
    const sd = (a) => { if (a.length < 2) return 0; const m = a.reduce((t, x) => t + x, 0) / a.length; return Math.sqrt(a.reduce((t, x) => t + (x - m) ** 2, 0) / (a.length - 1)); };
    const sdPos = Object.fromEntries(TS_POS.map((p) => [p, sd(rec.pool[p])])), vols = {};
    rec.vol = (pid) => { if (vols[pid] != null) return vols[pid]; const p = ppos(pid), o = rec.own[pid] || [], k = o.length, s0 = sdPos[p];
        return (vols[pid] = !s0 ? 1 : Math.max(0.55, Math.min(1.7, ((k * (k >= 2 ? sd(o) : s0)) + 6 * s0) / (k + 6) / s0))); };
    // his usual week: the 10th and 90th percentile of his draws at his average projection
    rec.band = (pid, avg) => { const P = rec.pool[ppos(pid)] || [], v = rec.vol(pid), q = (u) => avg * Math.max(0, 1 + ((P[Math.floor(u * (P.length - 1))] ?? 1) - 1) * v); return [q(0.1), q(0.9)]; };
    S.tsPools = rec; return rec;
}
// the best projected lineup a manager would set from these players, one week
function tsLineup(ids, w) {
    const slots = starterSlots(), pl = ids.map((pid) => ({ pid, p: ppos(pid), v: projOf(pid, w) || 0 })).sort((a, b) => b.v - a.v), used = new Set(), out = [];
    for (const s of slots) if (!FLEX[s]) { const x = pl.find((y) => !used.has(y.pid) && y.p === s); if (x) { used.add(x.pid); out.push(x.pid); } }
    for (const s of slots) if (FLEX[s]) { const x = pl.find((y) => !used.has(y.pid) && FLEX[s].includes(y.p)); if (x) { used.add(x.pid); out.push(x.pid); } }
    return out;
}
const tsActive = (R) => (R.players || []).filter((pid) => !(R.reserve || []).includes(pid) && !(R.taxi || []).includes(pid));
async function tsContext() {
    const games = await poEnsureData(); if (!games) return null;
    const cur = Math.max(1, S.curWeek), end = regSeasonEnd(), st = S.league.settings || {};
    const nPO = Math.min(st.playoff_teams || 6, S.rosters.length), size = 2 ** Math.ceil(Math.log2(Math.max(2, nPO))), nRounds = Math.log2(size), rt = st.playoff_round_type || 0;
    const roundWeeks = []; let w0 = st.playoff_week_start || end + 1;
    for (let r = 0; r < nRounds; r++) { const two = rt === 2 || (rt === 1 && r === nRounds - 1); roundWeeks.push(two ? [w0, w0 + 1] : [w0]); w0 += two ? 2 : 1; }
    const last = roundWeeks[roundWeeks.length - 1].slice(-1)[0];
    await Promise.all(Array.from({ length: Math.max(0, last - cur) }, (_, i) => loadProj(cur + 1 + i).catch(() => {})));
    const pools = await tsPools();
    const base = new Map(), h2hBase = {};
    for (const R of S.rosters) base.set(R.roster_id, { rid: R.roster_id, w: 0, l: 0, t: 0, pf: 0, division: (R.settings || {}).division || 0 });
    const result = (a, b, pa, pb) => { const A = base.get(a), B = base.get(b); if (!A || !B) return; A.pf += pa; B.pf += pb;
        if (pa > pb) { A.w++; B.l++; h2hBase[`${a}:${b}`] = (h2hBase[`${a}:${b}`] || 0) + 1; } else if (pb > pa) { B.w++; A.l++; h2hBase[`${b}:${a}`] = (h2hBase[`${b}:${a}`] || 0) + 1; } else { A.t++; B.t++; } };
    for (let w = 1; w < cur; w++) for (const g of games[w] || []) result(g.a, g.b, g.pa, g.pb);
    // the week under way counts as projected: points on the board plus what is still to play
    for (const g of games[cur] || []) { const ma = (S.matchups[cur] || []).find((m) => m.roster_id === g.a), mb = (S.matchups[cur] || []).find((m) => m.roster_id === g.b);
        result(g.a, g.b, ma ? muProjected(rosterById(g.a), ma) : g.pa, mb ? muProjected(rosterById(g.b), mb) : g.pb); }
    const simWeeks = []; for (let w = cur + 1; w <= end; w++) simWeeks.push(w);
    const allWeeks = []; for (let w = cur + 1; w <= last; w++) allWeeks.push(w);
    const R0 = Object.fromEntries(S.rosters.map((R) => [R.roster_id, tsActive(R)]));
    return { cur, end, simWeeks, allWeeks, games, base: [...base.values()], h2hBase, nPO, size, roundWeeks, reseed: !!st.playoff_seed_type, pools, R0, rids: S.rosters.map((R) => R.roster_id),
        book: poDefaultRules() };
}
// the standard bracket order for a power-of-two field, so 1 and 2 meet only in the final: 8 → 1 8 4 5 2 7 3 6
function tsOrder(n) { let o = [1]; while (o.length < n) { const m = o.length * 2 + 1, next = []; for (const x of o) next.push(x, m - x); o = next; } return o; }
const tsHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const tsU = (h, s, w) => { let x = (h ^ Math.imul(s + 1, 0x9E3779B1) ^ Math.imul(w + 7, 0x85EBCA77)) >>> 0; x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
// n seasons from season `from` on; `track` keeps each season's result for the teams named, for error bars
async function tsSim(ctx, R, n, track = []) {
    const P = ctx.pools, LU = {};
    for (const rid of ctx.rids) { LU[rid] = {}; for (const w of ctx.allWeeks) LU[rid][w] = tsLineup(R[rid] || [], w).map((pid) => ({ m: projOf(pid, w) || 0, pool: P.pool[ppos(pid)], v: P.vol(pid), h: tsHash(pid) })).filter((e) => e.m > 0); }
    const out = Object.fromEntries(ctx.rids.map((rid) => [rid, { po: 0, bye: 0, title: 0 }])), keep = Object.fromEntries(track.map((rid) => [rid, { po: new Uint8Array(n), title: new Uint8Array(n) }]));
    const order = tsOrder(ctx.size);
    for (let s = 0; s < n; s++) {
        if (s && s % 500 === 0) await tsYield();
        const memo = {}, score = (rid, w) => { const k = rid * 100 + w; if (memo[k] != null) return memo[k]; let t = 0;
            for (const e of LU[rid][w]) { const r = e.pool ? e.pool[Math.min(e.pool.length - 1, Math.floor(tsU(e.h, s, w) * e.pool.length))] : 1; t += Math.max(0, e.m * (1 + (r - 1) * e.v)); } return (memo[k] = t); };
        const T = new Map(); for (const b of ctx.base) T.set(b.rid, { ...b }); const h2h = { ...ctx.h2hBase };
        for (const w of ctx.simWeeks) for (const g of ctx.games[w] || []) { const A = T.get(g.a), B = T.get(g.b); if (!A || !B) continue; const sa = score(g.a, w), sb = score(g.b, w); A.pf += sa; B.pf += sb;
            if (sa >= sb) { A.w++; B.l++; h2h[`${g.a}:${g.b}`] = (h2h[`${g.a}:${g.b}`] || 0) + 1; } else { B.w++; A.l++; h2h[`${g.b}:${g.a}`] = (h2h[`${g.b}:${g.a}`] || 0) + 1; } }
        const res = FBCalc.applyRules(ctx.book, [...T.values()], (a, b) => [h2h[`${a}:${b}`] || 0, h2h[`${b}:${a}`] || 0], ctx.nPO), seeds = res.seeds.map((x) => x.rid);
        seeds.forEach((rid, i) => { const o = out[rid]; if (!o) return; o.po++; if (i < res.byes) o.bye++; if (keep[rid]) keep[rid].po[s] = 1; });
        // the bracket, round by round; a missing seed is a bye
        const play = (a, b, weeks) => { if (a == null) return b; if (b == null) return a; let x = 0, y = 0; for (const w of weeks) { x += score(a, w); y += score(b, w); } return x >= y ? a : b; };
        let field = order.map((sd) => seeds[sd - 1] ?? null);
        for (let ri = 0; ri < ctx.roundWeeks.length; ri++) {
            const weeks = ctx.roundWeeks[ri];
            // the first round keeps its byes; re-seeding starts after it
            if (ctx.reseed && ri > 0) { const alive = field.filter((x) => x != null).sort((a, b) => seeds.indexOf(a) - seeds.indexOf(b)), nf = []; for (let i = 0; i < alive.length / 2; i++) nf.push(play(alive[i], alive[alive.length - 1 - i], weeks)); field = nf; }
            else { const nf = []; for (let i = 0; i < field.length; i += 2) nf.push(play(field[i], field[i + 1], weeks)); field = nf; }
            if (field.length <= 1) break;
        }
        const champ = field[0]; if (champ != null && out[champ]) { out[champ].title++; if (keep[champ]) keep[champ].title[s] = 1; }
    }
    for (const rid of ctx.rids) { const o = out[rid]; o.po /= n; o.bye /= n; o.title /= n; }
    return { out, keep, n };
}
// a trade's moves applied to the rosters; the side taking more players drops its least useful bench player
function tsApply(ctx, moves) {
    const R = { ...ctx.R0 }, ros = (pid) => ctx.allWeeks.reduce((t, w) => t + (projOf(pid, w) || 0), 0);
    for (const rid of new Set(moves.flatMap((m) => [m.from, m.to]))) R[rid] = ctx.R0[rid].slice();
    for (const m of moves) { R[m.from] = R[m.from].filter((x) => x !== m.pid); R[m.to] = R[m.to].concat([m.pid]); }
    for (const rid of Object.keys(R)) { let extra = R[rid].length - ctx.R0[rid].length;
        while (extra-- > 0) { const starters = new Set(); for (const w of ctx.allWeeks) tsLineup(R[rid], w).forEach((x) => starters.add(x)); const bench = R[rid].filter((x) => !starters.has(x));
            const drop = (bench.length ? bench : R[rid]).slice().sort((a, b) => ros(a) - ros(b))[0]; R[rid] = R[rid].filter((x) => x !== drop); } }
    return R;
}
const tsMean = (ctx, ids) => ctx.allWeeks.reduce((t, w) => t + tsLineup(ids, w).reduce((u, pid) => u + (projOf(pid, w) || 0), 0), 0);
// What a team is playing for, from its own odds: a contender the title, a bubble team a playoff spot.
function tsGoal(base, rid) { const p = base.out[rid].po; return p >= 0.9 ? 'title' : p >= 0.25 ? 'po' : 'long'; }
function tsDelta(base, sim, rid, n) {
    const b = base.keep[rid], s = sim.keep[rid], d = { po: sim.out[rid].po - base.out[rid].po, title: sim.out[rid].title - base.out[rid].title, sePo: 0, seTitle: 0 };
    if (b && s) for (const k of ['po', 'title']) { let m = 0, v = 0; for (let i = 0; i < n; i++) m += s[k][i] - b[k][i]; m /= n; for (let i = 0; i < n; i++) v += (s[k][i] - b[k][i] - m) ** 2; d[k === 'po' ? 'sePo' : 'seTitle'] = Math.sqrt(v / Math.max(1, n - 1) / n); }
    return d;
}
// a baseline cut to its first n seasons, so a trade simulated over fewer seasons compares on the same draws
function tsCut(base, n) { const out = {}, keep = {}; for (const rid of Object.keys(base.out)) { const k = base.keep[rid]; if (!k) { out[rid] = base.out[rid]; continue; }
    const po = k.po.subarray(0, n), title = k.title.subarray(0, n); out[rid] = { po: po.reduce((t, x) => t + x, 0) / n, title: title.reduce((t, x) => t + x, 0) / n, bye: base.out[rid].bye }; keep[rid] = { po, title }; } return { out, keep, n }; }
async function tsRun() {
    const my = S.myRoster; if (!my) return;
    const key = `${S.leagueId}:${S.curWeek}:${S.rosters.map((R) => (R.players || []).join(',')).join('|')}:${Object.keys(S.proj).length}`;
    if (S.ts && (S.ts.key === key || S.ts.busy)) return;
    const ts = S.ts = { key, busy: true, phase: 'Reading the season from Sleeper', done: 0, total: 0, ideas: [], at: Date.now() };
    let lastPaint = 0; const paint = () => { if (Date.now() - lastPaint > 600) { lastPaint = Date.now(); render(); } };
    try {
        const ctx = await tsContext(); if (!ctx) throw new Error('The rest of the schedule isn’t in yet.');
        ts.ctx = ctx; ts.phase = 'Playing out the season'; paint();
        ts.base = await tsSim(ctx, ctx.R0, TS_N2, ctx.rids); ts.base1 = tsCut(ts.base, TS_N);
        // the quick read: every trade by what it does to each side's average lineup
        ts.phase = 'Looking at every trade'; paint(); await tsYield();
        const me = my.roster_id, M0 = Object.fromEntries(ctx.rids.map((rid) => [rid, tsMean(ctx, ctx.R0[rid])])), ros = (pid) => ctx.allWeeks.reduce((t, w) => t + (projOf(pid, w) || 0), 0);
        const pool = (rid, n) => ctx.R0[rid].filter((pid) => ['QB', 'RB', 'WR', 'TE'].includes(ppos(pid)) && ros(pid) >= 30).sort((a, b) => ros(b) - ros(a)).slice(0, n);
        const two = [], three = [];
        for (const t of ctx.rids) { if (t === me) continue; const mc = pool(me, 12), tc = pool(t, 12);
            for (const a of mc) for (const b of tc) two.push([{ from: me, to: t, pid: a }, { from: t, to: me, pid: b }]);
            for (let i = 0; i < mc.length; i++) for (let j = i + 1; j < mc.length; j++) for (const b of tc.slice(0, 6)) two.push([{ from: me, to: t, pid: mc[i] }, { from: me, to: t, pid: mc[j] }, { from: t, to: me, pid: b }]);
            for (const a of mc.slice(0, 6)) for (let i = 0; i < tc.length; i++) for (let j = i + 1; j < tc.length; j++) two.push([{ from: me, to: t, pid: a }, { from: t, to: me, pid: tc[i] }, { from: t, to: me, pid: tc[j] }]); }
        for (const A of ctx.rids) for (const B of ctx.rids) { if (A === me || B === me || A === B) continue;
            for (const x of pool(me, 6)) for (const y of pool(A, 6)) for (const z of pool(B, 6)) three.push([{ from: me, to: A, pid: x }, { from: A, to: B, pid: y }, { from: B, to: me, pid: z }]); }
        const quick = (moves) => { const R = tsApply(ctx, moves), ids = [...new Set(moves.flatMap((m) => [m.from, m.to]))]; return { moves, g: Object.fromEntries(ids.map((rid) => [rid, tsMean(ctx, R[rid]) - M0[rid]])) }; };
        const q2 = [], q3 = []; ts.total = two.length + three.length;
        for (let i = 0; i < two.length; i++) { const x = quick(two[i]); if (x.g[me] >= 1 && Object.entries(x.g).every(([rid, v]) => +rid === me || v >= -12)) q2.push(x); if (i % 300 === 0) { ts.done = i; paint(); await tsYield(); } }
        for (let i = 0; i < three.length; i++) { const x = quick(three[i]); if (x.g[me] >= 1 && Object.entries(x.g).every(([rid, v]) => +rid === me || v >= -6)) q3.push(x); if (i % 300 === 0) { ts.done = two.length + i; paint(); await tsYield(); } }
        const rank = (x) => x.g[me] + 0.5 * Math.min(0, ...Object.entries(x.g).filter(([rid]) => +rid !== me).map(([, v]) => v));
        const pick = [...q2.sort((a, b) => rank(b) - rank(a)).slice(0, 36), ...q3.sort((a, b) => rank(b) - rank(a)).slice(0, 8)];
        // the simulation, for the ones worth it; then the best of them again, over more seasons
        ts.phase = 'Simulating the best trades'; ts.done = 0; ts.total = pick.length; paint();
        for (const x of pick) {
            const ids = [...new Set(x.moves.flatMap((m) => [m.from, m.to]))], sim = await tsSim(ctx, tsApply(ctx, x.moves), TS_N, ids);
            ts.ideas.push({ moves: x.moves, mean: x.g, n: TS_N, d: Object.fromEntries(ids.map((rid) => [rid, tsDelta(ts.base1, sim, rid, TS_N)])) });
            ts.done++; paint();
        }
        const myBest = (goal) => ts.ideas.slice().sort((a, b) => b.d[me][goal] - a.d[me][goal]);
        const short = [...new Set([...myBest('title').slice(0, 8), ...myBest('po').slice(0, 8)])];
        ts.phase = 'Checking the best again'; ts.done = 0; ts.total = short.length; paint();
        for (const x of short) { const ids = Object.keys(x.d).map(Number), sim = await tsSim(ctx, tsApply(ctx, x.moves), TS_N2, ids);
            x.n = TS_N2; x.d = Object.fromEntries(ids.map((rid) => [rid, tsDelta(ts.base, sim, rid, TS_N2)])); ts.done++; paint(); }
        ts.phase = null;
    } catch (e) { console.warn(TAG, 'trade ideas:', e.message); ts.error = e.message; }
    finally { ts.busy = false; render(); }
}
// An offer you are part of, read the same way: each side's chances with and without it.
async function tsOfferRead(t) {
    const ts = S.ts; if (!ts || !ts.base || ts.busy) return null;
    S.tsOffers = S.tsOffers || {}; const k = `${ts.key}:${t.transaction_id}`;
    if (S.tsOffers[k]) return S.tsOffers[k];
    S.tsOffers[k] = { busy: true };
    const moves = Object.entries(t.adds || {}).map(([pid, to]) => ({ pid, to, from: (t.drops || {})[pid] })).filter((m) => m.from != null && ts.ctx.R0[m.from] && ts.ctx.R0[m.from].includes(m.pid));
    const ids = [...new Set(moves.flatMap((m) => [m.from, m.to]))];
    const sim = await tsSim(ts.ctx, tsApply(ts.ctx, moves), TS_N2, ids);
    S.tsOffers[k] = { d: Object.fromEntries(ids.map((rid) => [rid, tsDelta(ts.base, sim, rid, TS_N2)])), n: TS_N2 };
    render(); return S.tsOffers[k];
}

// ── Trades › Ideas: the cards ──
// Each idea is a card in the drawer's own shape: what you give and get, then each side's chances of the playoffs
// and of the title with and without it, what the other side is playing for, and average points last. A change
// inside the simulation's own noise reads ≈ 0. A trade that lowers the other side's chances stays, marked as a
// hard sell (the user, 2026-10-25).
const tiPct = (v) => `${v >= 0.995 ? Math.round(v * 100) : (v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
function tiChange(v, se) {
    if (Math.abs(v) < Math.max(0.001, 2 * (se || 0))) return h('span', { class: 'tich flat', title: `Within the simulation’s own noise${se ? ` (±${(se * 100).toFixed(1)})` : ''}` }, '≈ 0');
    return h('span', { class: `tich ${v > 0 ? 'up' : 'dn'}` }, `${v > 0 ? '▲ +' : '▼ −'}${Math.abs(v * 100).toFixed(1)}`);
}
function tiOdds(base, d, rid, me) {
    const b = base.out[rid];
    return h('div', { class: `tiod ${rid === me ? 'me' : 'them'}` }, h('span', { class: 'tiwho' }, rid === me ? 'You' : teamName(rosterById(rid))),
        h('span', { class: 'tiol' }, 'Playoffs ', h('b', null, tiPct(b.po)), ' ', tiChange(d.po, d.sePo)),
        h('span', { class: 'tiol' }, 'Title ', h('b', null, tiPct(b.title)), ' ', tiChange(d.title, d.seTitle)));
}
const TI_GOAL_WORDS = { title: 'a contender, so title odds are what move them', po: 'on the bubble, so a playoff spot comes first', long: 'a long shot, so hard to read' };
function tiHard(base, x, me) {
    for (const [rid, d] of Object.entries(x.d)) { if (+rid === me) continue; const g = tsGoal(base, +rid), k = g === 'title' ? 'title' : 'po', se = k === 'title' ? d.seTitle : d.sePo;
        if (d[k] < -Math.max(0.003, 2 * (se || 0))) return `${teamName(rosterById(+rid))}’s ${k === 'title' ? 'title' : 'playoff'} odds drop ${Math.abs(d[k] * 100).toFixed(1)}`; }
    return null;
}
// his usual week, from a bad one to a good one, at his average projection the rest of the way
function tiRange(pid) {
    const ts = S.ts, ws = ts.ctx.allWeeks, avg = ws.reduce((t, w) => t + (projOf(pid, w) || 0), 0) / Math.max(1, ws.length), [lo, hi] = S.tsPools.band(pid, avg), mx = 40;
    return [h('span', { class: 'tirg', title: `Most weeks between ${fmt0(lo)} and ${fmt0(hi)} (a bad week to a good one); ${fmt1(avg)} on average` },
        h('i', { style: `left:${Math.min(96, lo / mx * 100).toFixed(0)}%;width:${Math.max(3, Math.min(100, (hi - lo) / mx * 100)).toFixed(0)}%` }), h('b', { style: `left:${Math.min(97, avg / mx * 100).toFixed(0)}%` })),
        ` usually ${fmt0(lo)}–${fmt0(hi)}`];
}
function tiKind(x, me) { const ids = new Set(x.moves.flatMap((m) => [m.from, m.to])); if (ids.size === 3) return 'three'; const g = x.moves.filter((m) => m.from === me).length, r = x.moves.filter((m) => m.to === me).length; return g === 1 && r === 1 ? 'one' : g > r ? 'give2' : 'get2'; }
const tiKey = (x) => x.moves.map((m) => `${m.pid}>${m.to}`).sort().join(',');
function tiHidden() { try { return new Set(JSON.parse(localStorage.getItem(`badgerTiHide:${S.leagueId}`) || '[]')); } catch (e) { return new Set(); } }
function tiHide(x) { const s = tiHidden(); s.add(tiKey(x)); try { localStorage.setItem(`badgerTiHide:${S.leagueId}`, JSON.stringify([...s])); } catch (e) { /* this visit only */ } S.ui.tiHid = (S.ui.tiHid || 0) + 1; render(); }
function tiCard(x, alts, goal) {
    const ts = S.ts, me = S.myRoster.roster_id, kind = tiKind(x, me), others = Object.keys(x.d).map(Number).filter((rid) => rid !== me);
    const rows = kind === 'three'
        ? x.moves.map((m) => txRow(m.pid, { dir: m.to === me ? 'get' : m.from === me ? 'send' : null, noOpp: true, sub: [`${teamName(rosterById(m.from))} → ${teamName(rosterById(m.to))} · `, ...tiRange(m.pid)] }))
        : [...x.moves.filter((m) => m.to === me), ...x.moves.filter((m) => m.from === me)].map((m) => txRow(m.pid, { dir: m.to === me ? 'get' : 'send', noOpp: true, sub: tiRange(m.pid) }));
    const odds = h('div', { class: 'tiodds' }, tiOdds(ts.base, x.d[me], me, me), ...others.map((rid) => tiOdds(ts.base, x.d[rid], rid, me)));
    const sit = others.map((rid) => h('div', { class: `tisit ${tsGoal(ts.base, rid)}` }, `${teamName(rosterById(rid))} is ${TI_GOAL_WORDS[tsGoal(ts.base, rid)]}.`));
    const nW = ts.ctx.allWeeks.length, avg = h('div', { class: 'tiavg' }, `Average points the rest of the way: ${x.mean[me] >= 0 ? '+' : '−'}${fmt1(Math.abs(x.mean[me] / nW))} a week for you`,
        ...others.map((rid) => `, ${x.mean[rid] >= 0 ? '+' : '−'}${fmt1(Math.abs(x.mean[rid] / nW))} for ${teamName(rosterById(rid))}`));
    const hard = tiHard(ts.base, x, me), open = S.ui.tiAlts === tiKey(x);
    const altRows = open ? alts.map((a) => h('div', { class: 'tialt' }, h('span', null, a.moves.filter((m) => m.from === me).map((m) => shortName(m.pid)).join(' + ')), tiChange(a.d[me][goal], goal === 'title' ? a.d[me].seTitle : a.d[me].sePo),
        h('button', { class: 'lnk', type: 'button', onclick: () => tiPropose(a) }, 'Propose'))) : [];
    return txCard({ R: kind === 'three' ? null : rosterById(others[0]), who: kind === 'three' ? `3 teams · ${others.map((rid) => teamName(rosterById(rid))).join(' · ')}` : teamName(rosterById(others[0])),
        kind: { one: '1 FOR 1', give2: '2 FOR 1', get2: '1 FOR 2', three: '3 TEAMS' }[kind], pill: hard ? ['amb', 'HARD SELL'] : null, cls: 'ticard', attrs: { 'data-idea': tiKey(x), 'data-kind': kind },
        rows: [...rows, odds, ...sit, avg, ...(hard ? [h('div', { class: 'tihard' }, `Hard sell: ${hard}.`)] : []), ...altRows],
        acts: [h('button', { class: 'btn sm p', type: 'button', 'data-act': 'idea-propose', onclick: () => tiPropose(x) }, 'Propose ›'),
            alts.length ? h('button', { class: 'lnk', type: 'button', 'aria-expanded': String(open), onclick: () => { S.ui.tiAlts = open ? null : tiKey(x); render(); } }, `${alts.length} other way${alts.length === 1 ? '' : 's'} `, foldCaret(open)) : null,
            h('button', { class: 'lnk dim', type: 'button', 'data-act': 'idea-hide', onclick: () => tiHide(x) }, 'Not interested')].filter(Boolean) });
}
function txTradeIdeas() {
    const ts = S.ts, my = S.myRoster, me = my.roster_id, out = [];
    const dl = (S.league.settings || {}).trade_deadline;
    if (dl && S.curWeek > dl && dl <= LAST_WEEK) return [txEmpty(`Trades closed after week ${dl}. Ideas come back next season.`)];
    if (!ts || ts.key == null || (!ts.busy && !ts.base && !ts.error)) tsRun();
    if (ts && ts.error && !ts.base) return [txEmpty(`Couldn’t play out the season: ${ts.error}`)];
    if (!ts || !ts.base) return [txEmpty(ts && ts.phase ? `${ts.phase}…` : 'Reading the season from Sleeper…')];
    const b = ts.base.out[me], goal = S.ui.tiGoal || (b.po >= 0.9 ? 'title' : 'po');
    out.push(h('div', { class: 'tiyou' }, h('div', { class: 'tiyh' }, `You today, from ${TS_N2.toLocaleString()} simulated seasons`),
        h('div', { class: 'tiyo' }, h('span', null, 'Playoffs ', h('b', null, tiPct(b.po))), h('span', null, 'Bye ', h('b', null, tiPct(b.bye))), h('span', null, 'Title ', h('b', null, tiPct(b.title)))),
        h('div', { class: 'tigoal' }, h('span', { class: 'tigl' }, 'Rank by'), pills([['po', 'Playoff odds'], ['title', 'Title odds']], goal, (k) => { S.ui.tiGoal = k; render(); }, 'Rank by')),
        S.ui.tiGoal ? null : h('div', { class: 'tinote' }, b.po >= 0.9 ? 'You are safely in, so this starts on title odds.' : 'You are not in yet, so this starts on playoff odds.')));
    const kind = S.ui.tiKind || 'all';
    out.push(h('div', { class: 'txplrow' }, h('span'), pills([['all', 'All'], ['one', '1 for 1'], ['give2', '2 for 1'], ['get2', '1 for 2'], ['three', '3 teams']], kind, (k) => { S.ui.tiKind = k; render(); }, 'Kind of trade')));
    const hidden = tiHidden(), se = (x) => goal === 'title' ? x.d[me].seTitle : x.d[me].sePo;
    // your gain, less three quarters of what the other side loses in the odds IT plays for: a hard sell stays in the
    // list, below trades nearly as good for you that they would take
    const partnerLoss = (x) => Math.min(0, ...Object.entries(x.d).filter(([rid]) => +rid !== me).map(([rid, d]) => d[tsGoal(ts.base, +rid) === 'title' ? 'title' : 'po']));
    const score = (x) => x.d[me][goal] + 0.75 * partnerLoss(x);
    const list = ts.ideas.filter((x) => !hidden.has(tiKey(x)) && (kind === 'all' || tiKind(x, me) === kind) && x.d[me][goal] > Math.max(0.001, 2 * se(x)))
        .sort((a, c) => score(c) - score(a));
    // packages for the same player(s) from the same team(s) fold into one idea, its other ways under it
    const groups = new Map();
    for (const x of list) { const k = `${Object.keys(x.d).sort().join(',')}|${x.moves.filter((m) => m.to === me).map((m) => m.pid).sort().join(',')}`; if (!groups.has(k)) groups.set(k, { best: x, alts: [] }); else groups.get(k).alts.push(x); }
    out.push(txHead(`Trades that raise your ${goal === 'title' ? 'title' : 'playoff'} odds`, ts.busy ? `${ts.phase}… ${ts.done} of ${ts.total}` : `${ts.ideas.length} simulated`, { cols: true }));
    if (!groups.size) out.push(txEmpty(ts.busy ? 'Simulating; ideas appear here as each one finishes.' : `No trade the simulation found raises your ${goal === 'title' ? 'title' : 'playoff'} odds by more than its own noise. Try the other ranking, or come back after the next waiver run.`));
    for (const g of [...groups.values()].slice(0, 12)) out.push(tiCard(g.best, g.alts.slice(0, 3), goal));
    out.push(h('div', { class: 'txfoot2' }, `Each player’s week is drawn from what happened to projections at his position this season; every team starts its best projected lineup; the season and the bracket play out ${TS_N2.toLocaleString()} times, a trade on the same draws as without it.`));
    return out;
}
// Propose: today's trade screen with both sides in, or, for three teams, a screen of its own
function tiPropose(x) {
    const me = S.myRoster.roster_id, ids = [...new Set(x.moves.flatMap((m) => [m.from, m.to]))];
    if (ids.length === 2) {
        const other = ids.find((rid) => rid !== me);
        openTrade(other);
        for (const m of x.moves) (m.from === me ? S.ui.trade.give : S.ui.trade.get).add(m.pid);
        render(); return;
    }
    S.ui.trade3 = { moves: x.moves.slice(), days: 2, sending: false };
    Object.assign(S.ui.tx, { view: 'trade3', from: S.ui.tx.view || 'list' }); render();
}
function trade3Body() {
    const t3 = S.ui.trade3, me = S.myRoster.roster_id, ids = [...new Set(t3.moves.flatMap((m) => [m.from, m.to]))].filter((rid) => rid !== me);
    return [h('div', { class: 'txempty' }, `One offer to ${ids.map((rid) => teamName(rosterById(rid))).join(' and ')}. It goes through when both accept.`),
        ...t3.moves.map((m) => txRow(m.pid, { dir: m.to === me ? 'get' : m.from === me ? 'send' : null, noOpp: true, sub: `${teamName(rosterById(m.from))} → ${teamName(rosterById(m.to))}` })),
        h('div', { class: 'txplrow' }, h('span', { class: 'shm' }, 'Offer open for'), pills([[1, '1 day'], [2, '2 days'], [3, '3 days']], t3.days, (k) => { t3.days = k; render(); }, 'Offer open for')),
        h('div', { class: 'txacts' }, h('button', { class: 'btn p', type: 'button', disabled: t3.sending, 'data-act': 'trade3-send', onclick: sendTrade3 }, t3.sending ? 'Sending…' : 'Send to both managers'))];
}
async function sendTrade3() {
    const t3 = S.ui.trade3; if (!t3 || t3.sending) return;
    const adds = {}, drops = {}; for (const m of t3.moves) { adds[m.pid] = m.to; drops[m.pid] = m.from; }
    const a = kv(adds), dr = kv(drops), expires = Math.round(Date.now() / 1000) + t3.days * 86400;
    t3.sending = true; render();
    try {
        const d = await gql('propose_trade', `mutation propose_trade($k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]) { propose_trade(league_id: "${S.leagueId}", draft_picks: [], waiver_budget: [], expires_at: ${expires}, k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops){ transaction_id status } }`,
            { k_adds: a.keys, v_adds: a.values, k_drops: dr.keys, v_drops: dr.values });
        const id = d && d.propose_trade && d.propose_trade.transaction_id;
        S.ui.trade3 = null; if (S.ui.tx) Object.assign(S.ui.tx, { view: 'list', tab: 'trades', tpart: 'offers', justSent: id || null });
        toast('Three-team offer sent', 'ok'); await loadPending(); render();
    } catch (e) { t3.sending = false; render(); toast(e.message, 'err'); }
}
// an offer's read, under its rows: each side's chances with it
function tiOfferRead(t) {
    const ts = S.ts, me = S.myRoster.roster_id;
    if (!ts || !ts.base) { if (!ts || (!ts.busy && !ts.error)) tsRun(); return h('div', { class: 'tiavg' }, 'Playing out the season to read this offer…'); }
    const k = `${ts.key}:${t.transaction_id}`, r = (S.tsOffers || {})[k];
    if (!r) { tsOfferRead(t); return h('div', { class: 'tiavg' }, 'Reading this offer…'); }
    if (r.busy || !r.d || !r.d[me]) return h('div', { class: 'tiavg' }, 'Reading this offer…');
    return h('div', { class: 'tiodds' }, tiOdds(ts.base, r.d[me], me, me), ...Object.keys(r.d).map(Number).filter((rid) => rid !== me).map((rid) => tiOdds(ts.base, r.d[rid], rid, me)));
}

function txTradeHistory() {
    const tx = S.ui.tx, me = S.myRoster.roster_id, yours = tx.twho === 'yours', done = [], out = [];
    for (let w = 1; w <= Math.max(1, S.curWeek); w++) for (const t of S.txns[w] || []) if (t.type === 'trade' && t.status === 'complete') done.push(t);
    done.sort((a, b) => (b.status_updated || b.created) - (a.status_updated || a.created));
    const list = yours ? done.filter(t => (t.roster_ids || []).includes(me)) : done;
    out.push(h('div', { class: 'txplrow' }, h('span'), pills([['league', 'League'], ['yours', 'Yours']], yours ? 'yours' : 'league', (k) => { tx.twho = k; render(); }, 'Whose trades')));
    if (!list.length) out.push(txEmpty(S.txLoading ? 'Reading the league’s trades…' : yours ? 'You haven’t made a trade this season.' : 'No trades in this league yet this season.'));
    for (const t of list.slice(0, tx.tradesN || 10)) {
        const sides = (t.roster_ids || []).map(rid => {
            const got = Object.entries(t.adds || {}).filter(([, r]) => r === rid).map(([p]) => shortName(p))
                .concat((t.draft_picks || []).map(normPick).filter(dp => dp.owner_id === rid && dp.previous_owner_id !== rid).map(pickLabel))
                .concat(budgetOf(t).filter(b => b.receiver === rid).map(b => `$${b.amount} FAAB`));
            return `${rid === me ? 'You' : teamName(rosterById(rid))} get${rid === me ? '' : 's'} ${got.join(', ') || 'nothing'}`;
        });
        const d = new Date(t.status_updated || t.created);
        out.push(h('div', { class: 'txline' }, avatarEl(rosterById((t.roster_ids || [])[0]), 'xs'),
            h('div', { class: 'txw' }, h('b', { class: (t.roster_ids || []).includes(me) ? 'me' : '' }, (t.roster_ids || []).map(r => (r === me ? 'You' : teamName(rosterById(r)))).join(' ⇄ ')), h('div', { class: 'txsub', title: sides.join(' · ') }, sides.join(' · '))),
            h('span', { class: 'txwhen' }, d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))));
    }
    if (list.length > (tx.tradesN || 10)) out.push(h('button', { class: 'txmore', type: 'button', onclick: () => { tx.tradesN = (tx.tradesN || 10) + 10; render(); } }, 'Earlier trades'));
    return out;
}

// ── the drawer ──
function txDrawer() {
    const tx = S.ui.tx; if (!tx || !S.myRoster) return null;
    if (!tx.part) tx.part = 'claims'; if (!tx.tpart || (tx.tpart === 'review' && !amCommish())) tx.tpart = 'offers';
    const back = (label, fn) => h('button', { class: 'btn sm s', type: 'button', 'data-act': 'tx-back', onclick: fn || (() => txBack('list')) }, label || '‹ Transactions');
    let w = 420, head, body, top = null;
    if (tx.view === 'trade' && S.ui.trade) { w = 760; head = [back(), h('span', null, 'Propose a trade')]; body = [tradeBody()]; }
    else if (tx.view === 'trade3' && S.ui.trade3) { w = 520; head = [back('‹ Ideas', () => { S.ui.trade3 = null; tx.view = 'list'; tx.tab = 'trades'; tx.tpart = 'ideas'; render(); }), h('span', null, 'Propose a three-team trade')]; body = trade3Body(); }
    else if (tx.view === 'cut') {
        w = 1060; const vs = tx.vs && tx.pick && tx.pick.pid === tx.vs ? tx.vs : null;
        head = vs ? [back(`‹ ${tx.pick.waiv ? 'Claim' : 'Add'}`, () => { tx.view = 'list'; tx.part = 'ideas'; render(); }), h('span', null, `Your roster against ${pname(vs)}`)] : [back(), h('span', null, 'Your roster against waivers')];
        body = txCut();
    } else {
        tx.view = 'list'; head = [h('span', null, 'Transactions')]; top = [txTabs(), ...txPinned(), txParts()];
        body = tx.tab === 'trades' ? (tx.tpart === 'history' ? txTradeHistory() : tx.tpart === 'review' ? txReview() : tx.tpart === 'ideas' ? txTradeIdeas() : txOffers()) : tx.part === 'ideas' ? txIdeas() : tx.part === 'history' ? txHistory() : txClaims();
    }
    const part = tx.tab === 'trades' ? tx.tpart : tx.part;
    return h('div', { class: 'drawer txd', style: `width:${w}px`, role: 'dialog', 'aria-label': 'Transactions', 'data-view': tx.view, 'data-tab': tx.tab, 'data-part': part },
        h('div', { class: 'dh' }, ...head, h('span', { style: 'flex:1' }), h('button', { class: 'btn sm s', type: 'button', onclick: closeTx }, 'Close · Esc')),
        top ? h('div', { class: 'txtop' }, ...top) : null,
        h('div', { class: 'db', 'data-keep': `tx-${tx.view}-${tx.tab}-${part}` }, ...body));
}

// ── who to cut: your roster against the waiver wire ──
// Receivers, backs and tight ends you roster, lowest rest-of-season projection
// first (Sleeper's, in this league's scoring), each with the best player on
// waivers at his position who isn't Out or on IR. An upgrade is one who projects
// at least ten more the rest of the way: less than that is noise. Opportunity
// sits beside it as the check — early in the season, among players scoring the
// same, the one with more of it scored more later — placed among the position
// the way the player card places it.
const CUT_POS = ['WR', 'RB', 'TE'], CUT_GAIN = 10;
function oppKey(pos) {
    const k = keyColFor(pos); if (!k) return null;
    return { k, label: USAGE[k][0], get: (e) => { const x = usageVal(e, k); return x == null && USAGE_ZERO.has(k) ? 0 : x; }, show: (x) => usageFmt(k, x) };
}
function cutBoard() {
    const my = S.myRoster; if (!my || !S.ros) return null;
    const rostered = rosteredSet(), starters = new Set((my.starters || []).filter(p => p && p !== '0')), reserve = new Set(my.reserve || []);
    const best = {};
    for (const pos of CUT_POS) best[pos] = Object.keys(S.ros).filter(pid => ppos(pid) === pos && !rostered.has(pid) && (P(pid) || {}).team && !/^(out|ir|pup|sus|na|doubtful)/i.test(statusOf(pid) || ''))
        .sort((a, b) => (txRos(b) || 0) - (txRos(a) || 0))[0] || null;
    const rows = (my.players || []).filter(pid => CUT_POS.includes(ppos(pid))).map(pid => {
        const pos = ppos(pid), ros = txRos(pid) || 0, fa = best[pos], gain = fa ? (txRos(fa) || 0) - ros : 0;
        const out = /^(out|ir|pup|sus)/i.test(statusOf(pid) || '');
        return { pid, pos, ros, fa, gain, up: !!fa && gain >= CUT_GAIN, slot: reserve.has(pid) ? 'IR' : starters.has(pid) ? 'START' : 'BENCH', out };
    }).sort((a, b) => a.ros - b.ros);
    return { rows, best };
}
const cutPick = (fa, drop) => openComposer(fa, onWaiversNow(fa), drop);
// The drawer's wide view, two ways. Against the wire: every receiver, back and
// tight end you roster, each beside the best player on waivers at his position.
// Against one player (opened from a claim, tx.vs): everyone you could drop for
// him, each beside what swapping him in is worth — and Drop him picks that drop.
function txCut() {
    const tx = S.ui.tx, c = tx.pick, vs = tx.vs && c && c.pid === tx.vs ? tx.vs : null;
    const b = cutBoard(), pool = wantL4(), my = S.myRoster;
    if (!b) return [txEmpty('Reading Sleeper’s rest-of-season projections…')];
    const who = (pid) => (P(pid) || {}).last_name || pname(pid);
    const gl = (...kids) => sv('svg', { class: 'udots', width: 12, height: 12, viewBox: '-6 -1 12 12', 'aria-hidden': 'true' }, ...kids);
    const n = S.rosters.length || 12, wk = txWeek();
    const starters = new Set((my.starters || []).filter(p => p && p !== '0'));
    const rows = vs
        ? (my.players || []).filter(p => !(my.reserve || []).includes(p) && !(my.taxi || []).includes(p)).map(pid => ({ pid, pos: ppos(pid), ros: txRos(pid) || 0, slot: starters.has(pid) ? 'START' : 'BENCH' })).sort((x, y) => x.ros - y.ros)
        : b.rows;
    const tickOf = (r) => vs ? txRos(vs) || 0 : r.fa ? txRos(r.fa) || 0 : null;
    const maxRos = Math.max(1, ...rows.map(r => r.ros), ...(vs ? [txRos(vs) || 0] : CUT_POS.map(p => b.best[p] ? txRos(b.best[p]) || 0 : 0)));
    // where a player's opportunity stands at his position, the card's strip and its two marks
    const oppCell = (pid) => {
        const pos = ppos(pid), ok = oppKey(pos), d = pool && ok ? usageDist(pool, pos, ok.k, ok.get) : null, l4 = pool ? pool[pid] : null;
        if (!ok) return h('div', { class: 'cutopp shm' }, pos === 'QB' ? 'no opportunity number for quarterbacks' : 'no opportunity number for kickers and defences');
        const v = l4 ? ok.get(l4) : null, pct = d && v != null ? usagePct(d, v) : null;
        const vsTxt = v == null || !d ? null : d.top != null && v >= d.top ? `at or above the top ${n}` : d.st != null && v >= d.st ? 'above the typical starter' : 'below the typical starter';
        return h('div', { class: 'cutopp' },
            h('div', { class: 'lab' }, h('span', { title: pct ? `${ordinal(pct)} percentile of the ${d.pop.length} ${posLabel(pos)}s on the field for a quarter of their team’s snaps, last four games` : null }, ok.label, ' ', h('b', null, v == null ? '—' : ok.show(v)), pct ? ` · ${ordinal(pct)}` : ''), vsTxt ? h('span', null, vsTxt) : null),
            d && v != null ? usageStrip(d, v, ok.show, ok.label, who(pid)) : null,
            d ? h('div', { class: 'refs' }, h('span', null, gl(sv('path', { class: 'st', d: STARTER_MARK(0, 3) })), 'typical starter ', h('b', null, d.st != null ? ok.show(d.st) : '—')), h('span', null, gl(sv('path', { class: 'tp', d: TOP_MARK(0, 2.5) })), `top ${n} `, h('b', null, d.top != null ? ok.show(d.top) : '—'))) : null);
    };
    const rosCell = (pid, pos, ros, tick) => h('div', { class: 'cutros' }, h('span', { class: 't' }, h('i', { style: `width:${ros / maxRos * 100}%` }), tick != null ? h('b', { style: `left:${tick / maxRos * 100}%` }) : null),
        h('span', { class: 'n mono' }, fmt0(ros), h('small', null, rosRank(pid) ? `${posLabel(pos)}${rosRank(pid)}` : '')));
    const ppg = (pid) => { const l4 = pool ? pool[pid] : null; return h('div', { class: 'r mono cutpts' }, l4 && l4.gp ? fmt1(l4.pts / l4.gp) : '—'); };
    const sign = (v) => `${v > 0 ? '+' : ''}${fmt1(v)}`, dcls = (v) => `delta ${v > 0 ? 'up' : v < 0 ? 'dn' : ''}`;
    const out = [h('div', { class: 'txbar' }, h('span', { class: 'shm' }, `Lowest rest-of-season projection first · Sleeper’s, weeks ${Math.max(1, S.curWeek)}–${LAST_WEEK}`)),
        h('div', { class: 'ulegend' },
            h('span', null, h('i', { class: 'cutkey ros' }), 'his rest of season'), h('span', null, h('i', { class: 'cutkey tick' }), vs ? `${pname(vs)}’s rest of season` : 'the best on waivers at his position'),
            h('span', null, gl(sv('circle', { class: 'pd', cx: -2.5, cy: 6, r: 1.6 }), sv('circle', { class: 'pd top', cx: 2.5, cy: 6, r: 1.6 })), `each dot a player at his position (brighter: the top ${n})`),
            h('span', null, gl(sv('path', { class: 'st', d: STARTER_MARK(0, 3) })), 'typical starter'), h('span', null, gl(sv('path', { class: 'tp', d: TOP_MARK(0, 2.5) })), `top ${n}`)),
        h('div', { class: 'cutg cuth' }, h('span', null, 'PLAYER'), h('span', null, 'REST OF SEASON'), h('span', { class: 'r' }, 'PTS/G'), h('span', null, 'OPPORTUNITY AT HIS POSITION · LAST 4'),
            h('span', null, vs ? `WITH ${who(vs).toUpperCase()} FOR HIM` : `BEST ON WAIVERS · ${CUT_GAIN}+ MORE`))];
    // the player you are claiming, on top, so every row below reads against him
    if (vs) out.push(h('div', { class: 'cutg cutr cutvs', 'data-cut': vs },
        h('div', { class: 'txw cutw' }, nameLine(vs, true), h('div', { class: 'cutm' }, h('span', { class: 'dir in' }, 'ADD'), h('span', { class: c.waiv ? 'amber' : '' }, c.waiv ? clearsLabel(vs) : 'free agent'))),
        rosCell(vs, ppos(vs), txRos(vs) || 0, null), ppg(vs), oppCell(vs),
        h('div', { class: 'cutfa' }, h('div', { class: 'cutfn' }, h('span', { class: 'shm' }, 'rest of season'), h('b', null, fmt0(txRos(vs) || 0))),
            h('div', { class: 'cutfn' }, h('span', { class: 'shm' }, `week ${wk}`), h('b', null, fmt1(txWk(vs) || 0))))));
    for (const r of rows) {
        let last;
        if (vs) {
            const dR = (txRos(vs) || 0) - r.ros, dW = (txWk(vs) || 0) - (txWk(r.pid) || 0), on = c.drops[0] === r.pid;
            last = h('div', { class: 'cutfa' }, h('div', { class: 'cutfn' }, h('span', { class: 'shm' }, 'rest of season'), h('b', { class: dcls(dR) }, sign(dR))),
                h('div', { class: 'cutfn' }, h('span', { class: 'shm' }, `week ${wk}`), h('b', { class: dcls(dW) }, sign(dW))),
                h('button', { class: `btn sm ${on ? 'danger' : 's'}`, 'data-act': 'cut-drop', 'aria-pressed': on ? 'true' : 'false', onclick: () => { c.drops[0] = r.pid; tx.view = 'list'; tx.part = 'ideas'; render(); } }, on ? `Dropping ${who(r.pid)} ✓` : `Drop ${who(r.pid)}`));
        } else last = h('div', { class: 'cutfa' }, !r.up ? h('span', { class: 'shm' }, `no one on waivers projects ${CUT_GAIN} more`) : [
            h('div', { class: 'cutfn' }, h('b', null, pname(r.fa)), h('span', { class: 'delta up' }, `+${fmt0(r.gain)}`)),
            h('div', { class: 'shm' }, (() => { const ok = oppKey(r.pos), d = pool && ok ? usageDist(pool, r.pos, ok.k, ok.get) : null, fv = ok && pool && pool[r.fa] ? ok.get(pool[r.fa]) : null;
                return `${(P(r.fa) || {}).team || ''} · ${fmt0(txRos(r.fa) || 0)} · ${posLabel(r.pos)}${rosRank(r.fa) || '?'}${ok && fv != null ? ` · ${ok.label} ${ok.show(fv)}${d ? ` (${ordinal(usagePct(d, fv))})` : ''}` : ''}${statusOf(r.fa) ? ' · ' + statusOf(r.fa) : ''}`; })()),
            r.slot !== 'IR' ? h('button', { class: `btn sm ${onWaiversNow(r.fa) ? 'warn' : 'p'}`, 'data-act': 'cut-claim', onclick: () => cutPick(r.fa, r.pid) }, onWaiversNow(r.fa) ? `+ Claim, drop ${who(r.pid)}` : `+ Add, drop ${who(r.pid)}`) : null]);
        out.push(h('div', { class: `cutg cutr${vs && c.drops[0] === r.pid ? ' on' : ''}`, 'data-cut': r.pid },
            h('div', { class: 'txw cutw' }, nameLine(r.pid, true), h('div', { class: 'cutm' }, h('span', { class: r.slot === 'START' ? 'cst' : '' }, r.slot), !vs && r.up && r.slot !== 'IR' && !r.out ? h('span', { class: 'cutc' }, 'CUT CANDIDATE') : null)),
            rosCell(r.pid, r.pos, r.ros, tickOf(r)), ppg(r.pid), oppCell(r.pid), last));
    }
    if (!pool) out.push(txEmpty('Adding up everyone’s last four games…'));
    return out;
}
function budgetOf(t) {
    // waiver_budget comes back as objects from REST and as "sender,receiver,amount" strings from GraphQL
    return (t.waiver_budget || []).map(b => typeof b === 'string' ? (([s, r, a]) => ({ sender: Number(s), receiver: Number(r), amount: Number(a) }))(b.split(',')) : b);
}
function tradeCardTx(t) {
    const tx = S.ui.tx, my = S.myRoster, me = my.roster_id, role = tradeRole(t);
    const others = (t.roster_ids || []).filter(x => x !== me), R = rosterById(others[0]);
    const get = Object.entries(t.adds || {}).filter(([, rid]) => rid === me).map(([p]) => p);
    const send = Object.entries(t.drops || {}).filter(([, rid]) => rid === me).map(([p]) => p);
    const picks = (t.draft_picks || []).map(normPick);
    const pickRow = (dp, dir) => h('div', { class: 'txr txpk' }, h('span', { class: 'hs txpkic' }, 'PICK'), h('span', { class: `dir ${dir === 'get' ? 'in' : 'out'}` }, DIRS[dir]), h('div', { class: 'txw' }, h('b', null, pickLabel(dp))), h('span'), h('span'));
    const cash = budgetOf(t);
    const cashRow = (b, dir) => h('div', { class: 'txr txpk' }, h('span', { class: 'hs txpkic' }, '$'), h('span', { class: `dir ${dir === 'get' ? 'in' : 'out'}` }, DIRS[dir]), h('div', { class: 'txw' }, h('b', null, `$${b.amount} FAAB`)), h('span'), h('span'));
    const rows = [...get.map(p => txRow(p, { dir: 'get' })), ...picks.filter(dp => dp.owner_id === me && dp.previous_owner_id !== me).map(dp => pickRow(dp, 'get')), ...cash.filter(b => b.receiver === me).map(b => cashRow(b, 'get')),
        ...send.map(p => txRow(p, { dir: 'send' })), ...picks.filter(dp => dp.previous_owner_id === me).map(dp => pickRow(dp, 'send')), ...cash.filter(b => b.sender === me).map(b => cashRow(b, 'send'))];
    const exp = t.settings && t.settings.expires_at ? t.settings.expires_at * 1000 - Date.now() : null;
    const left = exp == null ? null : exp <= 0 ? 'expired' : exp < 86400e3 ? `${Math.max(1, Math.round(exp / 3600e3))}h left` : `${Math.round(exp / 86400e3)}d left`;
    const otherName = others.map(r => teamName(rosterById(r))).join(', ');
    const wk = txWeek(), net = get.reduce((s, p) => s + (projOf(p, wk) || 0), 0) - send.reduce((s, p) => s + (projOf(p, wk) || 0), 0);
    let foot = null, acts = [];
    if (role === 'toyou') {
        foot = h('span', { class: `delta ${net > 0 ? 'up' : net < 0 ? 'dn' : ''}` }, `${net > 0 ? '+' : ''}${fmt1(net)} wk ${wk} for you`);
        acts = [h('button', { class: 'btn sm p', 'data-act': 'trade-accept', 'data-txn': t.transaction_id, onclick: () => confirm(`Accept: ${tradeSummary(t)}?`) && act(() => respondTrade(t, true), 'Trade accepted') }, 'Accept'),
            h('button', { class: 'btn sm danger', 'data-act': 'trade-reject', 'data-txn': t.transaction_id, onclick: () => act(() => respondTrade(t, false), 'Trade rejected') }, 'Reject')];
    } else if (role === 'sent') {
        foot = `Waiting on ${otherName}`;
        acts = [h('button', { class: 'btn sm s', onclick: () => showOriginalNav(`/leagues/${S.leagueId}/trades`) }, 'View'),
            h('button', { class: 'btn sm danger', 'data-act': 'trade-cancel', 'data-txn': t.transaction_id, onclick: () => act(() => respondTrade(t, false), `Offer to ${otherName} cancelled`) }, 'Cancel')];
    } else foot = 'Accepted · in league review';
    const fresh = tx.justSent && String(tx.justSent) === String(t.transaction_id);
    if (role === 'toyou' || role === 'sent') rows.push(tiOfferRead(t));   // each side's chances with it, the way Ideas reads a trade
    return txCard({ R, who: otherName || 'Trade', kind: 'TRADE', pill: role === 'toyou' ? ['amb', 'TO YOU'] : role === 'sent' ? ['wait', 'SENT'] : ['wait', 'IN REVIEW'], when: left,
        cls: fresh ? 'txfresh' : '', attrs: { 'data-trade': t.transaction_id, 'data-role': role }, rows,
        foot: fresh ? [h('b', { class: 'txjust' }, 'Just sent'), ' · ', foot] : foot, acts });
}
// Review: each trade in league review, both sides, what will happen, and the commissioner's two moves. Each move
// asks once in the card, since neither can be undone.
function txReview() {
    const list = reviewTrades(), days = (S.league.settings || {}).trade_review_days || 0;
    if (!list.length) return [txEmpty(`No trade is waiting on your review. When both teams accept one, it waits here${days ? ` through the league’s ${days}-day review` : ''}, and you can approve it now or veto it.`)];
    return [h('div', { class: 'txcols' }, h('span'), h('span', { class: 'txc' }, `WK ${txWeek()}`), h('span', { class: 'txc' }, 'RoS')), ...list.map(reviewCardTx)];
}
function reviewCardTx(t) {
    const tx = S.ui.tx, ask = tx.ask && tx.ask.id === t.transaction_id ? tx.ask.kind : null, ends = reviewEnds(t), cap = rosterPositions().filter(x => x !== 'IR' && x !== 'TAXI').length;
    const picks = (t.draft_picks || []).map(normPick), cash = budgetOf(t), days = (S.league.settings || {}).trade_review_days || 0;
    const sides = (t.roster_ids || []).map(rid => { const R = rosterById(rid), held = new Set([...(R.reserve || []), ...(R.taxi || [])]);
        const gets = Object.entries(t.adds || {}).filter(([, r]) => r === rid).map(([p]) => p), sends = Object.entries(t.drops || {}).filter(([, r]) => r === rid).map(([p]) => p);
        const active = (R.players || []).filter(p => !held.has(p)).length;
        return { R, rid, gets, sends, after: active - sends.filter(p => !held.has(p)).length + gets.length, ros: gets.reduce((a, p) => a + (txRos(p) || 0), 0) }; });
    const extra = (s) => [...picks.filter(dp => dp.owner_id === s.rid && dp.previous_owner_id !== s.rid).map(dp => h('div', { class: 'txr txpk' }, h('span', { class: 'hs txpkic' }, 'PICK'), h('span'), h('div', { class: 'txw' }, h('b', null, pickLabel(dp))), h('span'), h('span'))),
        ...cash.filter(b => b.receiver === s.rid).map(b => h('div', { class: 'txr txpk' }, h('span', { class: 'hs txpkic' }, '$'), h('span'), h('div', { class: 'txw' }, h('b', null, `$${b.amount} FAAB`)), h('span'), h('span')))];
    const rk = (p) => rosRank(p) ? `${posLabel(ppos(p))}${rosRank(p)} by rest of season` : null;
    const says = [ends > Date.now() ? ['If nobody acts, it goes through ', h('b', null, atWhen(ends)), `, when the league’s ${days}-day review ends.`] : 'Its review has ended: Sleeper puts it through on its next pass.'];
    for (const s of sides) if (s.after > cap) says.push([h('b', null, teamName(s.R)), ` would have ${s.after} players for ${cap} spots. Sleeper locks their lineup until they drop ${s.after - cap === 1 ? 'one' : NUMW[s.after - cap] || s.after - cap}.`]);
    if (S.ros && sides.length === 2) says.push(['Rest of season, by Sleeper’s projection: ', teamName(sides[0].R), ' get ', h('b', null, fmt0(sides[0].ros)), ', ', teamName(sides[1].R), ' get ', h('b', null, fmt0(sides[1].ros)), '.']);
    const id = t.transaction_id, maker = (S.users || []).find(u => String(u.user_id) === String(t.creator));
    const move = (process) => txWrite(async () => { await commishTrade(t, process); tx.ask = null; }, process ? 'Trade approved' : 'Trade vetoed');
    const foot = ask === 'veto'
        ? h('div', { class: 'txask', 'data-ask': 'veto' }, h('span', null, h('b', null, 'Veto this trade? '), 'Both teams keep their players, and it can’t be undone.'),
            h('span', { class: 'txacts' }, h('button', { class: 'btn sm', type: 'button', 'data-act': 'review-keep', onclick: () => { tx.ask = null; render(); } }, 'Keep it'),
                h('button', { class: 'btn sm danger', type: 'button', 'data-act': 'review-veto-yes', 'data-txn': id, disabled: !!tx.busy, onclick: () => move(false) }, 'Veto trade')))
        : ask === 'process'
        ? h('div', { class: 'txask go', 'data-ask': 'process' }, h('span', null, h('b', null, 'Approve this trade now? '), 'It goes through at once, before the review ends.'),
            h('span', { class: 'txacts' }, h('button', { class: 'btn sm', type: 'button', 'data-act': 'review-keep', onclick: () => { tx.ask = null; render(); } }, 'Not yet'),
                h('button', { class: 'btn sm p', type: 'button', 'data-act': 'review-process-yes', 'data-txn': id, disabled: !!tx.busy, onclick: () => move(true) }, 'Approve trade')))
        : h('div', { class: 'txf' }, h('span', { class: 'txft', title: `Proposed ${atWhen(t.created)}, accepted ${atWhen(t.status_updated || t.created)}` }, maker ? `proposed by ${maker.display_name}` : ''),
            h('span', { class: 'txacts' }, h('button', { class: 'btn sm danger', type: 'button', 'data-act': 'review-veto', 'data-txn': id, onclick: () => { tx.ask = { id, kind: 'veto' }; render(); } }, 'Veto trade'),
                h('button', { class: 'btn sm p', type: 'button', 'data-act': 'review-process', 'data-txn': id, onclick: () => { tx.ask = { id, kind: 'process' }; render(); } }, 'Approve trade')));
    return h('div', { class: 'txcard txrv', 'data-review': id },
        h('div', { class: 'txh' }, h('span', { class: 'txpill amb' }, 'IN REVIEW'), h('b', { class: 'txrvt', title: sides.map(s => teamName(s.R)).join(' ⇄ ') }, sides.map(s => teamName(s.R)).join(' ⇄ ')), h('span', { class: 'txwhen', title: `The league’s ${days}-day review ends ${atWhen(ends)}` }, ends > Date.now() ? `ends ${atWhen(ends)}` : 'review over')),
        ...sides.flatMap(s => [h('div', { class: 'txrvs' }, avatarEl(s.R, 'xs'), h('b', null, teamName(s.R)), h('span', { class: 'shm' }, record(s.R)), h('span', { class: 'txrvg' }, 'gets')),
            ...s.gets.map(p => txRow(p, { noOpp: true, sub: rk(p) })), ...extra(s)]),
        h('div', { class: 'txrvw' }, 'What will happen'), h('ul', { class: 'txwill' }, ...says.map(x => h('li', null, x))),
        foot);
}
function trendingCard() {
    const tr = S.trending || {}; const rostered = rosteredSet();
    const top = Object.entries(tr).filter(([pid, v]) => v.add && P(pid) && POS_ORDER.includes(ppos(pid))).sort((a, b) => b[1].add - a[1].add).slice(0, 8);
    return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', null, 'Trending adds'), h('span', { class: 'dim', style: 'font-size:12px' }, 'all Sleeper leagues · 24h')),
        h('div', { class: 'feed' }, ...(top.length ? top.map(([pid, v]) => h('div', { class: 'it', style: 'grid-template-columns:1fr auto' }, h('div', null, h('span', { class: `pos ${ppos(pid)}` }, posLabel(ppos(pid))), ' ', h('b', { style: 'cursor:pointer', onclick: () => { S.ui.sel = pid; render(); } }, pname(pid)), rostered.has(pid) ? h('span', { class: 'dim' }, ' · rostered here') : ''), h('span', { class: 'delta up' }, `+${v.add >= 1000 ? (v.add / 1000).toFixed(1) + 'k' : v.add}`))) : [h('div', { class: 'empty' }, 'Loading…')])));
}

// ── Matchup ──────────────────────────────────────────────────────────────────
// ── matchup v2: mirrored spine, scoring windows, duels, paths ────────────────
const muLocked = (pid) => { const k = insKickInfo(pid); if (!k) return S.week < S.curWeek && !S.fracDone; return (k.status === 'in_game' || k.status === 'complete' || Date.parse(k.t) < Date.now()); };
// value for matchup math: actual once his game started, projection before
function muVal(m, pid) {
    if (!pid || pid === '0') return 0;
    const actual = m && m.players_points ? m.players_points[pid] : null;
    return muLocked(pid) && actual != null ? actual : (projOf(pid, S.week) || 0);
}
const muStarters = (R, m) => starterSlots().map((s, i) => ((m && m.starters) || R.starters || [])[i] || '0');
function ytpText(R, m) {
    if (!R) return '';
    const cnt = {}; let n = 0;
    for (const pid of muStarters(R, m)) {
        if (!pid || pid === '0' || isBye(pid, S.week) || muLocked(pid)) continue;
        n++; const p = ppos(pid); cnt[p] = (cnt[p] || 0) + 1;
    }
    const parts = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].filter(p => cnt[p]).map(p => cnt[p] > 1 ? `${cnt[p]} ${p}` : p);
    return `${n} yet to play${parts.length ? ' · ' + parts.join(', ') : ''}`;
}
function muBench(R, m) {
    const startersSet = new Set(muStarters(R, m).filter(p => p && p !== '0'));
    const reserve = R.reserve || [], taxi = R.taxi || [];
    return ((m && m.players) || R.players || []).filter(p => !startersSet.has(p) && !reserve.includes(p) && !taxi.includes(p))
        .sort((x, y) => (projOf(y, S.week) || 0) - (projOf(x, S.week) || 0));
}
// A finished week's one-line box score, from the archived weekly stats —
// what the vault shows where the live page shows kickoff-and-opponent.
function muStatLine(pid) {
    const st = ((S.stats[S.week] || {})[pid] || {}).stats;
    if (!st) return null;
    const bits = [];
    if (st.pass_att) bits.push(`${st.pass_cmp || 0}/${st.pass_att}, ${st.pass_yd || 0} yds${st.pass_td ? `, ${st.pass_td} TD` : ''}${st.pass_int ? `, ${st.pass_int} INT` : ''}`);
    if (st.rush_att) bits.push(`${st.rush_att} car, ${st.rush_yd || 0} yds${st.rush_td ? `, ${st.rush_td} TD` : ''}`);
    if (st.rec) bits.push(`${st.rec}/${st.rec_tgt || st.rec} rec, ${st.rec_yd || 0} yds${st.rec_td ? `, ${st.rec_td} TD` : ''}`);
    else if (st.rec_tgt) bits.push(`0/${st.rec_tgt} rec`);
    if (st.fgm || st.fga || st.xpm || st.xpa) bits.push(`${st.fgm || 0}/${st.fga || st.fgm || 0} FG, ${st.xpm || 0} XP`);
    if (ppos(pid) === 'DEF') {
        const d = [];
        if (st.sack) d.push(`${st.sack} sck`);
        const to = (st.int || 0) + (st.fum_rec || 0); if (to) d.push(`${to} TO`);
        const td = (st.def_td || 0) + (st.st_td || 0); if (td) d.push(`${td} TD`);
        if (st.pts_allow != null) d.push(`${st.pts_allow} PA`);
        if (d.length) bits.push(d.join(', '));
    }
    if (st.fum_lost) bits.push(`${st.fum_lost} fum lost`);
    return bits.length ? h('div', { class: 'statl' }, bits.join(' \u00b7 ')) : null;
}
// His face, ringed by his game's clock (the user, 2026-10-25): a full ring before kickoff (all sixty minutes to play),
// an arc that empties as they run, none once it is final. Teal for the left team, blue for the right, as on the win chart.
function clockFace(pid, right) {
    const left = Math.min(1, gameFracLeft(pid)), pre = left >= 1, live = left > 0 && left < 1, r = 21.5, c = 2 * Math.PI * r;
    const ring = left > 0 ? sv('circle', { cx: 23, cy: 23, r, fill: 'none', class: `cfarc ${right ? 'op' : 'me'}`, 'stroke-dasharray': `${(c * left).toFixed(1)} ${c.toFixed(1)}`, transform: 'rotate(-90 23 23)' }) : null;
    return h('span', { class: 'cface', title: pre ? 'His game has not started' : live ? `About ${Math.max(1, Math.round(left * 60))} of 60 minutes left in his game` : 'His game is over' },
        sv('svg', { viewBox: '0 0 46 46', 'aria-hidden': 'true' }, sv('circle', { cx: 23, cy: 23, r, fill: 'none', class: 'cftrack' }), ring),
        h('img', { src: headshot(pid), alt: '', loading: 'lazy', onerror: hideBroken }));
}
function muPlayerCell(pid, right, m, slot) {
    const cls = right ? 'op' : 'me';
    if (!pid || pid === '0') {
        // Red means the slot will produce nothing, whoever owns it — the same
        // thing it means on a ruled-out player, and that marker already runs on
        // both sides. No remedy line here: naming a free agent is a sentence, and
        // a sentence in one name column drags the scores off the spine. The Team
        // page is where the fix belongs, and it already says it there.
        if (!slot) return h('td', { class: cls }, h('div', { class: 'nm dim' }, 'Empty slot'));
        return h('td', { class: `${cls} emptyslot` }, h('div', { class: 'nm warn' }, '\u26a0 Empty slot'));
    }
    const pos = ppos(pid);
    // Same token order on both sides — only the alignment mirrors. The bye is
    // left out here: this is the week's matchup, so a bye eleven weeks off is
    // noise, and a D/ST's name already says its team.
    const nm = h('div', { class: 'nm', onclick: () => { S.ui.sel = pid; render(); } },
        h('span', { class: 'mnm', title: pname(pid) }, pname(pid)), pos === 'DEF' ? null : h('span', { class: 'posl' }, pos), teamMeta(pid, true),
        S.fracDone ? null : injuryChip(pid, true), S.fracDone ? null : newsIcon(pid));
    const text = h('div', { class: 'mutx' }, nm, S.fracDone ? muStatLine(pid) : gameSub(pid)), face = clockFace(pid, right);
    return h('td', { class: `${cls}${willNotPlay(pid) ? ' np' : ''}` }, h('div', { class: `mucell${right ? ' r' : ''}` }, right ? [text, face] : [face, text]));
}
// One cell per side rather than two: what he has, large, and a projection small
// underneath. While his game runs that is where he is heading; once it is over
// it is the projection he started the day with, so a final score still says
// whether he beat it.
//
// A player's own projection is static all week, so the number underneath is not
// it: it is what he has scored plus his projection scaled by the share of his
// game still to run. Sleeper never computes this per player; it is the same
// quantity the win probability is built on.
function muPts(pid, m, right, live, slot) {
    const cls = `${right ? 'ptsR' : 'ptsL'} mustack${pid && willNotPlay(pid) ? ' np' : ''}${(!pid || pid === '0') && slot ? ' emptyslot' : ''}`;
    const cell = (big, small, dim) => h('td', { class: cls }, h('div', { class: `big${dim ? ' dim' : ''}` }, big), small ? h('div', { class: 'small' }, small) : null);
    if (!pid || pid === '0') return cell('—', null, true);
    const proj = projOf(pid, S.week) || 0, left = gameFracLeft(pid);
    if (left >= 1) return live ? cell('—', `${fmtS(proj)} proj`, true) : cell(fmtS(proj), null);
    const actual = ((m && m.players_points) || {})[pid] || 0;
    if (left <= 0) return cell(fmtS(actual), `${fmtS(proj)} proj`);
    return cell(fmtS(actual), `${fmtS(actual + proj * left)} proj`);
}
function muMirror(A, a, B, b) {
    const slots = starterSlots();
    const anyLive = [...muStarters(A, a), ...muStarters(B, b)].some(pid => pid && pid !== '0' && muLocked(pid));
    // Fixed layout, with only the two name columns left to share what remains:
    // whatever a row puts in them, the numbers and the slot chip stay on the
    // spine. Nothing a player is called can pull the score off centre.
    const tbl = h('table', { class: 'mu' }, h('colgroup', null,
        h('col'), h('col', { style: 'width:70px' }), h('col', { style: 'width:58px' }), h('col', { style: 'width:70px' }), h('col')));
    const label = (anyLive || S.fracDone) ? 'Pts' : 'Proj';
    tbl.append(h('tr', null, h('th', { style: 'text-align:left' }, teamName(A)),
        h('th', { class: 'r' }, label), h('th', null, ''), h('th', { style: 'text-align:left' }, label),
        h('th', { style: 'text-align:right' }, teamName(B))));
    slots.forEach((sl, i) => {
        const pA = muStarters(A, a)[i], pB = muStarters(B, b)[i];
        tbl.append(h('tr', null, muPlayerCell(pA, false, a, sl),
            muPts(pA, a, false, anyLive, sl),
            h('td', { class: 'slotc' }, slotChip(sl, null, [pA, pB])),
            muPts(pB, b, true, anyLive, sl),
            muPlayerCell(pB, true, b, sl)));
    });
    const bA = muBench(A, a), bB = muBench(B, b);
    const sum = (list, m) => list.reduce((tt, pid) => tt + muVal(m, pid), 0);
    // the bench folds: one click on its bar, remembered
    if (S.ui.muBench === undefined) { try { S.ui.muBench = localStorage.getItem('badgerMuBench') !== 'closed'; } catch (e) { S.ui.muBench = true; } }
    const benchOpen = S.ui.muBench, flip = () => { S.ui.muBench = !S.ui.muBench; try { localStorage.setItem('badgerMuBench', S.ui.muBench ? 'open' : 'closed'); } catch (e) { /* this visit only */ } render(); };
    tbl.append(h('tr', { class: 'sec fold', onclick: flip, title: benchOpen ? 'Hide the benches' : 'Show the benches' }, h('td', { colspan: 2 }, foldCaret(benchOpen, 'chev'), ` BENCH — NOT COUNTING · ${fmtS(sum(bA, a))}`), h('td', { class: 'slotc' }), h('td', { colspan: 2, style: 'text-align:right' }, `${fmtS(sum(bB, b))} · BENCH`)));
    for (let i = 0; benchOpen && i < Math.max(bA.length, bB.length); i++) {
        const pA = bA[i] || null, pB = bB[i] || null;
        tbl.append(h('tr', { class: 'bench' }, muPlayerCell(pA, false, a),
            muPts(pA, a, false, anyLive),
            h('td', { class: 'slotc' }, h('span', { class: 'pos BN' }, 'BN')),
            muPts(pB, b, true, anyLive),
            muPlayerCell(pB, true, b)));
    }
    const view = muH2HView();
    return h('div', { class: 'card mumir' }, h('div', { class: 'card-h' }, h('h3', null, 'Head to head'),
            h('span', { class: 'wlens' }, ...[['players', 'PLAYERS'], ['positions', 'POSITIONS']].map(([k, t]) => h('span', { class: view === k ? 'on' : '', onclick: () => setMuH2HView(k) }, t)))),
        h('div', { class: 'muscroll', 'data-keep': `mumir-${view}` }, view === 'positions' ? muPositions(A, a, B, b, anyLive) : tbl));
}

function muH2HView() { if (S.ui.muH2H) return S.ui.muH2H; let v = 'players'; try { v = localStorage.getItem('badgerMuH2H') === 'positions' ? 'positions' : 'players'; } catch (e) {} return (S.ui.muH2H = v); }
function setMuH2HView(v) { S.ui.muH2H = v; try { localStorage.setItem('badgerMuH2H', v); } catch (e) {} render(); }
// Head to head by POSITION (the user, 2026-10-25): each position adds up its slots, flex a position of its own,
// what each side has with its projected finish under it; press a position to open its players, slot against slot.
function muPositions(A, a, B, b, anyLive) {
    const slots = starterSlots(), sa = muStarters(A, a), sb = muStarters(B, b), groups = [], by = {};
    slots.forEach((sl, i) => { const k = slotLabel(sl); if (!by[k]) groups.push(by[k] = { k, sl, idx: [] }); by[k].idx.push(i); });
    const live = anyLive || S.fracDone, ok = (pid) => pid && pid !== '0';
    const has = (m, pid) => !ok(pid) ? 0 : live ? (((m && m.players_points) || {})[pid] || 0) : (projOf(pid, S.week) || 0);
    const fin = (m, pid) => !ok(pid) ? 0 : (live ? (((m && m.players_points) || {})[pid] || 0) : 0) + (projOf(pid, S.week) || 0) * (live ? Math.max(0, gameFracLeft(pid)) : 1);
    const rows = groups.map((g) => ({ g, ta: g.idx.reduce((t, i) => t + has(a, sa[i]), 0), tb: g.idx.reduce((t, i) => t + has(b, sb[i]), 0),
        fa: g.idx.reduce((t, i) => t + fin(a, sa[i]), 0), fb: g.idx.reduce((t, i) => t + fin(b, sb[i]), 0),
        left: g.idx.reduce((t, i) => t + [sa[i], sb[i]].filter((pid) => ok(pid) && gameFracLeft(pid) > 0).length, 0) }));
    const max = Math.max(1, ...rows.map((r) => Math.max(r.ta, r.tb)));
    S.ui.muPosOpen = S.ui.muPosOpen || {};
    const tag = (pid) => !ok(pid) ? 'empty' : gameFracLeft(pid) <= 0 ? 'final' : gameFracLeft(pid) >= 1 ? 'to play' : 'live';
    const who = (pid, right, m) => h('span', { class: `ppn${right ? ' r' : ''}` }, ok(pid) && !right ? clockFace(pid, false) : null,
        h('span', null, h('b', null, ok(pid) ? ((P(pid) || {}).last_name || pname(pid)) : 'Empty slot'), h('small', { class: tag(pid) === 'live' ? 'lv' : '' }, tag(pid))), ok(pid) && right ? clockFace(pid, true) : null);
    const out = [];
    let wa = 0, wb = 0;
    for (const r of rows) {
        const open = !!S.ui.muPosOpen[r.g.k], n = r.g.idx.length;
        if (r.ta > r.tb) wa++; else if (r.tb > r.ta) wb++;
        out.push(h('div', { class: `pgrow${open ? ' open' : ''}`, role: 'button', tabindex: '0', 'aria-expanded': String(open), 'data-focus': `mupos:${r.g.k}`,
            onclick: () => { S.ui.muPosOpen[r.g.k] = !open; render(); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.ui.muPosOpen[r.g.k] = !open; render(); } } },
            foldCaret(open, 'chev'),
            h('span', { class: `pgv mono${r.ta > r.tb ? ' lead' : ''}` }, fmtS(r.ta), live ? h('small', null, `${fmtS(r.fa)} proj`) : null),
            h('span', { class: 'pgb l' }, h('i', { style: `width:${(r.ta / max * 100).toFixed(1)}%` })),
            h('span', { class: 'pgl' }, slotChip(r.g.sl, null, r.g.idx.flatMap((i) => [sa[i], sb[i]])), h('small', null, [n > 1 ? `${n} v ${n}` : '', r.left ? `${r.left} to play` : ''].filter(Boolean).join(' · '))),
            h('span', { class: 'pgb r' }, h('i', { style: `width:${(r.tb / max * 100).toFixed(1)}%` })),
            h('span', { class: `pgv r mono${r.tb > r.ta ? ' lead' : ''}` }, fmtS(r.tb), live ? h('small', null, `${fmtS(r.fb)} proj`) : null)));
        if (open) for (const i of r.g.idx) out.push(h('div', { class: 'pprow' }, who(sa[i], false, a),
            h('span', { class: `mono${has(a, sa[i]) > has(b, sb[i]) ? ' lead' : ''}` }, ok(sa[i]) ? fmtS(has(a, sa[i])) : '—'),
            h('span', { class: `mono r${has(b, sb[i]) > has(a, sa[i]) ? ' lead' : ''}` }, ok(sb[i]) ? fmtS(has(b, sb[i])) : '—'), who(sb[i], true, b)));
    }
    return h('div', { class: 'pgs' }, h('div', { class: 'pghead' }, h('span', { class: 'a' }, teamName(A)), h('span', null, live ? 'Pts' : 'Proj'), h('span', { class: 'b' }, teamName(B))), ...out,
        h('div', { class: 'cap' }, `${teamName(A)} leads ${wa} of ${rows.length} positions, ${teamName(B)} ${wb}. A position adds up its slots; flex is a position of its own.`));
}
function muEdge(A, a, B, b) {
    const slots = starterSlots();
    const duels = slots.map((sl, i) => { const pA = muStarters(A, a)[i], pB = muStarters(B, b)[i]; return { sl, pA, pB, d: muVal(a, pA) - muVal(b, pB) }; })
        .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    const total = duels.reduce((tt, x) => tt + x.d, 0);
    const tbl = h('table', null);
    let holeSaid = false, edgeSaid = false;
    for (const du of duels) {
        const bothEmpty = (!du.pA || du.pA === '0') && (!du.pB || du.pB === '0');
        let note = '';
        if (bothEmpty) note = 'both empty — whoever fills it first takes the swing';
        else if (du.d < 0 && !holeSaid) { note = 'your biggest hole'; holeSaid = true; }
        else if (du.d > 0 && !edgeSaid) { note = 'your biggest edge' + (statusOf(du.pA) ? ` — and he's ${statusOf(du.pA)}` : ''); edgeSaid = true; }
        tbl.append(h('tr', null, h('td', { style: 'width:56px' }, slotChip(du.sl)),
            h('td', null, `${du.pA && du.pA !== '0' ? (P(du.pA) || {}).last_name || pname(du.pA) : 'Empty'}`, h('span', { class: 'dim' }, ' vs '), `${du.pB && du.pB !== '0' ? (P(du.pB) || {}).last_name || pname(du.pB) : 'Empty'}`),
            h('td', { class: 'r mono', style: `width:64px;color:var(--${du.d > 0.05 ? 'green' : du.d < -0.05 ? 'red' : 'ink-3'})` }, `${du.d > 0 ? '+' : du.d < 0 ? '−' : ''}${fmt1(Math.abs(du.d))}`),
            h('td', { class: 'dim dnote', style: 'font-size:11px' }, note)));
    }
    tbl.append(h('tr', null, h('td'), h('td', { class: 'dim' }, 'total'), h('td', { class: 'r mono', style: 'font-weight:700' }, `${total >= 0 ? '+' : '−'}${fmt1(Math.abs(total))}`), h('td')));
    const card = h('div', { class: 'card scroll-x' }, h('div', { class: 'card-h' }, h('h3', null, "Where it's won"), h('span', { class: 'dim', style: 'font-size:12px' }, 'duel margins, biggest first')), tbl);
    // Paths — only for my own matchup: my moves when trailing, their threats when leading
    const my = S.myRoster;
    if (my && A.roster_id === my.roster_id) {
        const margin = muProjected(A, a) - muProjected(B, b);
        const trailing = margin < 0;
        const R = trailing ? A : B;
        const snap = insightsSnapshot(R);
        const moves = [];
        for (const ins of insCompute(snap)) {
            if (ins.type === 'empty_slot' && snap.best_available) { const pos = ins.action && ins.action.position; const fa = pos && snap.best_available[pos]; if (fa) moves.push({ d: fa.proj, txt: `fill the empty ${pos} — best FA ${fa.name} (${fmt1(fa.proj)})` }); }
            else if (ins.type === 'bench_beats' && ins.delta) moves.push({ d: ins.delta, txt: `start ${(P(ins.ref) || {}).last_name || pname(ins.ref)} over ${(P(ins.action.target_ref) || {}).last_name || pname(ins.action.target_ref)}` });
            else if (ins.type === 'early_q_late_cover') moves.push({ d: 0, txt: ins.text, plan: true });
        }
        moves.sort((x, y) => y.d - x.d);
        if (moves.length) {
            const ptbl = h('table', null);
            for (const mv of moves.slice(0, 4)) {
                const after = trailing ? margin + mv.d : margin - mv.d;
                ptbl.append(h('tr', null, h('td', { class: 'mono', style: `width:60px;font-weight:700;color:var(--${mv.plan ? 'amber' : trailing ? 'green' : 'red'})` }, mv.plan ? 'plan' : `${trailing ? '+' : '−'}${fmt1(mv.d)}`),
                    h('td', null, (trailing ? '' : 'They could ') + mv.txt, mv.plan ? null : h('b', null, ` → ${after >= 0 ? (trailing ? ' you’d lead' : ' you’d still lead') : ' you’d trail'} by ${fmt1(Math.abs(after))}`))));
            }
            card.append(h('div', { class: 'card-h', style: 'margin-top:14px' }, h('h3', null, trailing ? `Paths to +${fmt1(-margin)}` : 'What could beat you'), h('span', { class: 'dim', style: 'font-size:12px' }, trailing ? 'concrete moves, best swing first' : 'their best available swings')), ptbl);
        }
    }
    return card;
}

// Scorecard tiles for this week's matchups — shared by the Matchup page and
// the Home toggle card. onPick receives the clicked roster_id.
// The week's matchups, one entry per game, in the order both the strip and the
// Wall draw them: my matchup, then games involving my division, then the rest.
function muPairs() {
    const ms = S.matchups[S.week] || [];
    const pairs = ms.filter(m => S.rosters.find(r => r.roster_id === m.roster_id)).reduce((acc, m) => { if (!acc.some(x => x.matchup_id === m.matchup_id)) acc.push(m); return acc; }, []);
    const myMid = (myMatchup(S.week) || { mine: {} }).mine.matchup_id;
    const myDiv = S.myRoster && ((S.myRoster.settings || {}).division || 0);
    const rankOf = (m) => {
        if (m.matchup_id === myMid) return 0;
        if (!myDiv) return 2;
        const both = ms.filter(z => z.matchup_id === m.matchup_id);
        return both.some(z => { const R = rosterById(z.roster_id); return R && ((R.settings || {}).division || 0) === myDiv; }) ? 1 : 2;
    };
    return pairs.sort((x, y) => rankOf(x) - rankOf(y));
}
// Everything a summary of one matchup needs, computed in ONE place so the tile
// strip and the Wall can never tell different stories about the same game.
//
// LIVE means somebody is ON THE FIELD, nothing weaker. It used to fire on
// lockedN > 0 — and "locked" only means a player's game has kicked off,
// including games that finished on Thursday — so every tile read LIVE all week
// with nobody playing. Between kickoff and the last whistle, when the field is
// empty, the honest tag is how much football is still owed. Sleeper reports
// in-progress two ways — metadata.is_in_progress and a status string — and only
// ever populates one of them reliably, so take either.
//
// And once the football starts, a summary says what the SCORE is: a tile
// labelled LIVE showing a projected final reports a number nobody has earned.
// Before kickoff the projection is all there is, so it stands in.
function muState(X, m, Y, o) {
    const active = [...muStarters(X, m), ...(Y ? muStarters(Y, o) : [])].filter(pid => pid && pid !== '0');
    const lockedN = active.filter(pid => muLocked(pid)).length;
    const onField = active.some(pid => { const k = insKickInfo(pid); return !!k && (k.live || k.status === 'in_game'); });
    // Final means every starter's game is OVER. It used to mean every starter's
    // game had KICKED OFF (the lineup lock), which is the same thing all week —
    // until the last game of the week is live, when it called all six FINAL.
    const doneN = active.filter(pid => gameFracLeft(pid) === 0).length;
    const state = active.length && doneN === active.length ? 'fin' : onField ? 'live' : lockedN > 0 ? 'idle' : 'proj';
    const running = state !== 'proj';
    // The projected FINAL: what each starter has, plus the unplayed share of his
    // projection. muTotal counts a player at his points so far the moment his
    // game kicks off, so mid-game the Wall's "proj" fell as teams scored — a
    // Thursday RB two carries in was worth two points to the forecast. The
    // deep dive's header has always used this one; now both agree.
    const pX = muProjected(X, m), pY = Y ? muProjected(Y, o) : 0;
    return { active, lockedN, onField, state, running, leftN: active.length - lockedN, pX, pY,
        vX: running ? (m.points || 0) : pX, vY: running ? (o ? o.points || 0 : 0) : pY,
        // never certainty while football remains: 1 to 99 until the matchup is final, as on the matchup card.
        // The tiles alone rounded freely, and read 100% beside the card's 99% and the log's 99.9%.
        wX: ((w) => state === 'fin' ? w : Math.max(1, Math.min(99, w)))(Math.round(winProbFor(X, m, Y, o) * 100)) };
}
const muTag = (st) => st.state === 'proj' ? 'PROJ' : st.state === 'live' ? '\u25cf LIVE' : st.state === 'idle' ? `${st.leftN} TO PLAY` : 'FINAL';
function matchupTiles(activeMatchupId, onPick) {
    const ms = S.matchups[S.week] || [];
    const pairs = muPairs();
    // Balanced rows, not a greedy wrap. flex-wrap fills the first row and dumps
    // the remainder on the second — six tiles came out 4 + 2, which reads as a
    // mistake. Pick the column count instead: rows = ceil(n / 4), and then
    // cols = ceil(n / rows) spreads them evenly. Six becomes 3 + 3, eight 4 + 4,
    // seven the unavoidable 4 + 3.
    const rowsN = Math.max(1, Math.ceil(pairs.length / 4));
    const colsN = Math.max(1, Math.ceil(pairs.length / rowsN));
    return h('div', { class: 'mstrip', style: `--mcols:${colsN}` }, ...pairs.map(m => {
        const X = rosterById(m.roster_id);
        const o = ms.find(z => z.matchup_id === m.matchup_id && z.roster_id !== m.roster_id);
        const Y = o ? rosterById(o.roster_id) : null;
        const on = activeMatchupId && m.matchup_id === activeMatchupId;
        const st = muState(X, m, Y, o);
        const { wX, running, pX, pY, vX, vY } = st;
        // Row: avatar · name · share% (in its bar-segment colour) · score.
        // % and score are fixed right-aligned columns so totals never wander.
        const mrow = (R, v, lead, side) => h('div', { class: `trw ${lead ? '' : 'lose'}` },
            avatarEl(R, 'sm'),
            // No .slice(0, 16). That was sized for a 214px tile; the tiles are
            // 388px now and .nm2 already ellipsises, so let CSS decide where a
            // name has to stop instead of cutting every one of them mid-word.
            h('b', { class: 'nm2', title: teamName(R) || '' }, teamName(R) || ''),
            S.myRoster && R.roster_id === S.myRoster.roster_id ? h('span', { class: 'you2' }, 'YOU') : null,
            h('span', { class: `pct2 mono ${side}`, title: 'Chance of winning' }, `${side === 't' ? wX : 100 - wX}%`),
            // The projection is not lost, it just stops pretending to be the score.
            h('span', { class: 'sc2 mono', title: running ? `Projected final ${fmtS(side === 't' ? pX : pY)}` : null }, fmtS(v)));
        return h('div', { class: `mcard ${on ? 'on' : ''}`, onclick: () => onPick(m.roster_id) },
            h('span', { class: `tag ${st.state}` }, muTag(st)),
            mrow(X, vX, vX >= vY, 't'),
            Y ? mrow(Y, vY, vY > vX, 'b') : h('div', { class: 'trw lose' }, h('b', { class: 'nm2 dim' }, 'Bye')),
            h('div', { class: 'wbar' }, h('i', { class: 't', style: `width:${wX}%` }), h('i', { class: 'b', style: `width:${100 - wX}%` })));
    }));
}

// ── the all-six view ─────────────────────────────────────────────────────────
// The deep dive answers "how is THIS game going". This answers "how is the WEEK
// going": six games at equal billing, each one a scoreline and one sentence,
// and under them four charts of what moved and who moved it. The chyron and
// the charts replaced a window strip and a 3px win bar that nobody could read.
const kickMs = (k) => { if (!k || !k.t) return null; const ms = Date.parse(k.t); return isFinite(ms) ? ms : (isFinite(Number(k.t)) ? Number(k.t) : null); };
// The earliest kickoff among a roster's starters who have not played yet.
function nextKick(R, m) {
    let best = null;
    if (R) for (const pid of muStarters(R, m)) {
        if (!pid || pid === '0' || muLocked(pid)) continue;
        const ms = kickMs(insKickInfo(pid));
        if (ms != null && (best == null || ms < best)) best = ms;
    }
    return best;
}
// The day word for a chyron's bug and the time for its sentence, in the
// viewer's own clock: TONIGHT / 8:15, or SUN / Sun 1:00.
function kickWords(ms) {
    const d = new Date(ms), now = new Date();
    const t = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`;
    const same = d.toDateString() === now.toDateString();
    return { day: same ? (d.getHours() >= 17 ? 'TONIGHT' : 'TODAY') : DAY[d.getDay()].toUpperCase(), when: same ? t : `${DAY[d.getDay()]} ${t}` };
}
// J.Smith-Njigba, not Jaxon Smith-Njigba: a chyron is a third of the page wide,
// and the phrase after the name is the part worth keeping. A defence keeps its
// own name, which is already short.
const chyName = (pid) => { const p = P(pid) || {};
    return p.position === 'DEF' ? pname(pid)
        : p.last_name ? `${(p.first_name || '').charAt(0) ? (p.first_name || '').charAt(0) + '.' : ''}${p.last_name}` : pname(pid); };
const pctTxt = (dw) => `${dw > 0 ? '+' : dw < 0 ? '−' : ''}${Math.abs(dw * 100).toFixed(1)}%`;
const openGame = (g) => { S.ui.matchupRoster = g.A.roster_id; S.ui.muView = 'one'; render(); };
const hideBroken = (e) => { e.target.style.visibility = 'hidden'; };
// A player's face with the fantasy team the play helped pinned to its corner:
// who did it and whose week it changed, in one 26px mark.
const faceEl = (pid, R) => h('span', { class: 'hsw' },
    h('img', { class: 'hsf', src: pid ? headshot(pid) : '', alt: '', loading: 'lazy', onerror: hideBroken }),
    R && teamAvatar(R) ? h('img', { class: 'hsb', src: teamAvatar(R), alt: '' }) : null);
// Every starter in the league this week, once, with what he has and what he was
// signed up for. The two player charts are both views of this one list.
function leagueStarters() {
    const out = [];
    for (const m of (S.matchups[S.week] || [])) {
        const R = rosterById(m.roster_id); if (!R) continue;
        for (const pid of muStarters(R, m)) {
            if (!pid || pid === '0') continue;
            const pts = (m.players_points || {})[pid];
            out.push({ pid, R, pts: pts == null ? 0 : pts, proj: projOf(pid, S.week) || 0,
                played: 1 - gameFracLeft(pid), started: muLocked(pid) });
        }
    }
    return out;
}
// One play, said from the side of the player it was worth most to.
//  - A play can touch two starters (a touchdown pass pays the quarterback AND
//    the receiver) and a line has room for one name. Naming the offence put
//    "Drake Maye sacked, -7" beside a PLUS, because the sack paid the defence
//    on the same roster more than it cost him.
//  - A ledger's dw is signed for side A of ITS OWN matchup. Stacked with five
//    other games that made a 45-yard touchdown read −9.1%. Across the league
//    the only sign that means anything is the scorer's own.
//  - The ledger logs incompletions as sweat. They moved nothing, and the feed
//    was designed never to show them, so they stop here.
function playOf(g, ev) {
    if (ev.kind === 'clock') return null;   // time running out is not a play
    const own = ev.side === 'b' ? -ev.dw : ev.dw;
    if (Math.abs(own) < 0.0005) return null;
    const first = (ev.who || []).slice().sort((p, q) => Math.abs(q.dp || 0) - Math.abs(p.dp || 0))[0];
    let phrase = playPhrase(ev.desc);
    if (first && ppos(first.pid) === 'QB') phrase = phrase.replace(/^TD catch/, 'TD pass').replace(/^catch,/, 'pass,');
    // A defence is paid by the yards it gives up, so every offensive play
    // touches one, and "SEA D/ST catch, 2 yds" reads as the defence catching
    // it. From its side those are things allowed; a sack it did itself.
    if (first && ppos(first.pid) === 'DEF') {
        if (/^sacked/.test(phrase)) phrase = phrase.replace(/^sacked/, 'sack');
        else if (/^(catch|run|pass|TD|XP|FG)/.test(phrase)) phrase += ' allowed';
    }
    return { t: ev.t, pid: first ? first.pid : null, phrase, dw: own, dp: first ? (first.dp || 0) : (ev.dp || 0), tot: first && first.tot != null ? first.tot : null,
        helped: ev.side === 'b' ? g.B : g.A, clock: playQuarter(ev.q) ? `${playQuarter(ev.q)} ${ev.clk || ''}`.trim() : '', desc: ev.desc || '', g, sa: ev.sa, sb: ev.sb };
}
// The week's games, each with its priced ledger and its plays, newest first.
// Ledgers are memoised on the play count and the fetch time, so a re-render is
// free and only a fresh feed pays again — which is why they are built here,
// while the all-six view is on screen, and nowhere else.
function sixGames() {
    const ms = S.matchups[S.week] || [];
    const rec = S.plays[S.week], havePlays = !!(rec && rec.list && rec.list.length);
    return muPairs().map((m) => {
        const A = rosterById(m.roster_id);
        const o = ms.find(z => z.matchup_id === m.matchup_id && z.roster_id !== m.roster_id) || null;
        const B = o ? rosterById(o.roster_id) : null;
        const g = { m, o, A, B, L: null, plays: [], st: A ? muState(A, m, B, o) : null,
            mine: !!(A && S.myRoster && (A.roster_id === S.myRoster.roster_id || (B && B.roster_id === S.myRoster.roster_id))) };
        if (havePlays && A) { try { g.L = ledgerFor(A, m, B, o); } catch (e) { console.warn(TAG, 'all-six ledger:', e.message); } }
        if (g.L && g.L.events) for (const ev of g.L.events) { const p = playOf(g, ev); if (p) g.plays.push(p); }
        return g;
    }).filter(g => g.A);
}
// ── the chyron ───────────────────────────────────────────────────────────────
// One sentence about where the game STANDS, chosen by rules, first match wins:
//   final · not started · big play (one play moved it 5%+) · underdog
//   (ahead on the scoreboard, under 50%) · coin flip (within 4 of 50/50) ·
//   comeback (the favourite has changed since the start)
// and when none of those is true, the game's last play that moved it half a
// percent. Built from nodes, never markup: team names are typed by the people
// in the league.
function chyron(g) {
    const { A, B, m, o, st } = g;
    const line = (kind, bugKids, txt, clk) => h('div', { class: 'chy' },
        h('span', { class: `chybug k-${kind}` }, ...bugKids), h('span', { class: 'chytxt' }, ...txt), clk ? h('span', { class: 'chyclk mono' }, clk) : null);
    if (!B) return line('hl', ['BYE'], ['No opponent this week.']);
    const nA = teamName(A), nB = teamName(B), wA = st.wX, wB = 100 - st.wX;
    const hi = fmtS(Math.max(st.vX, st.vY)), lo = fmtS(Math.min(st.vX, st.vY));
    const kicks = [nextKick(A, m), nextKick(B, o)].filter(x => x != null);
    // Final: the tile already shows who won and both scores, so the chyron adds what
    // it does not — the margin and the game's best player, or that it was an upset.
    if (st.state === 'fin') {
        const margin = Math.abs(st.vX - st.vY), aWon = st.vX >= st.vY;
        if (margin < 0.005) return line('hl', ['FINAL'], ['Tied at ', h('b', null, hi)]);
        const pts = Object.assign({}, m.players_points || {}, (o && o.players_points) || {});
        const top = [...muStarters(A, m), ...muStarters(B, o)].filter(pid => pid && pid !== '0').sort((x, y) => (pts[y] || 0) - (pts[x] || 0))[0];
        const h0 = g.L && g.L.hist && g.L.hist.length ? g.L.hist[0] : null;   // the first odds the week recorded, before the plays moved them
        const startW = h0 == null ? null : (aWon ? h0 : 1 - h0);
        if (startW != null && startW <= 0.40) return line('play', [h('span', { class: 'chylab' }, 'UPSET')], [`Won from ${Math.round(startW * 100)}% at kickoff \u00b7 by `, h('b', null, fmtS(margin))]);
        return line('hl', ['FINAL'], [`Won by ${fmtS(margin)}`, ...(top ? [' \u00b7 ', h('b', null, chyName(top)), ` ${fmtS(pts[top] || 0)}`] : [])]);
    }
    if (st.state === 'proj') {
        const kw = kicks.length ? kickWords(Math.min(...kicks)) : null;
        return line('pre', [kw ? kw.day : 'SOON'], [kw ? 'Kicks off ' : '', kw ? h('b', null, kw.when) : null, kw ? ' \u00b7 ' : '',
            `${st.pX >= st.pY ? nA : nB} by ${fmt1(Math.abs(st.pX - st.pY))}`]);
    }
    const left = { a: toPlay(A, m), b: toPlay(B, o) };
    const best = g.plays.reduce((b, p) => !b || Math.abs(p.dw) > Math.abs(b.dw) ? p : b, null);
    // The player leads and the size rides in the bug: "One play moved this
    // game 9.1%: Jaxon Smith-N…" put the one thing worth reading past the cut.
    if (best && Math.abs(best.dw) >= 0.05) {
        const av = best.helped && teamAvatar(best.helped);
        return line(best.dw < 0 ? 'dn' : 'play', [h('span', { class: 'chylab' }, 'BIG PLAY'), av ? h('img', { src: av, alt: '' }) : null, `${best.dw < 0 ? '▼' : '▲'}${Math.abs(best.dw * 100).toFixed(1)}`],
            [h('b', null, chyName(best.pid)), ` ${best.phrase}`], best.clock);
    }
    const upA = st.vX > st.vY, upB = st.vY > st.vX;
    if ((upA && wA < 50) || (upB && wB < 50)) {
        const other = upA ? nB : nA, n = upA ? left.b : left.a;
        return line('hl', ['UNDERDOG'], ['Up ', h('b', null, `${hi}–${lo}`), n ? `, ${n} to play for ${other}` : `, ${other} is done`]);
    }
    if (Math.abs(wA - 50) <= 4) {
        const d = Math.abs(st.vX - st.vY), n = left.a + left.b;
        // A big lead that is still 50/50 is the same news as the underdog rule
        // and gets said the same way; "one team by 27.8, coin flip"
        // read as a typo.
        return line('hl', ['COIN FLIP'], d < 0.05 ? ['Level at ', h('b', null, fmt1(st.vX)), `, ${n} still to play`]
            : d >= 5 ? ['Up ', h('b', null, `${hi}–${lo}`), (upA ? left.b : left.a) ? `, ${upA ? left.b : left.a} to play for ${upA ? nB : nA}` : `, ${upA ? nB : nA} is done`]
                : [`${upA ? nA : nB} by `, h('b', null, fmt1(d)), `, ${n} still to play`]);
    }
    const h0 = g.L && g.L.hist && g.L.hist.length ? g.L.hist[0] : null;
    if (h0 != null && (h0 - 0.5) * (wA / 100 - 0.5) < 0 && Math.abs(h0 - 0.5) > 0.02) {
        const nowA = wA >= 50;
        return line('hl', ['COMEBACK'], [h('b', null, nowA ? nA : nB), ` has taken over: ${Math.round((nowA ? h0 : 1 - h0) * 100)}% at the start, ${nowA ? wA : wB}% now`]);
    }
    const last = g.plays.find(p => Math.abs(p.dw) >= 0.005) || g.plays[0];
    if (last) {
        const av = last.helped && teamAvatar(last.helped);
        return line(last.dw < 0 ? 'dn' : 'play', [av ? h('img', { src: av, alt: '' }) : null, `${last.dw < 0 ? '▼' : '▲'}${Math.abs(last.dw * 100).toFixed(1)}`],
            [h('b', null, chyName(last.pid)), ` ${last.phrase}`], last.clock);
    }
    if (kicks.length) { const kw = kickWords(Math.min(...kicks)); return line('pre', [kw.day], ['Next kickoff ', h('b', null, kw.when), `, ${left.a + left.b} still to play`]); }
    return line('hl', ['IN PLAY'], [`${left.a + left.b} still to play`]);
}
// ── a Wall cell ──────────────────────────────────────────────────────────────
// Win % to the LEFT of the name, as a number (the favourite in teal). The 3px
// bar it replaces could not tell 54/46 from a coin flip. Under each name, how
// many are left to play and where that lands.
function sixCell(g, viewId) {
    const { A, B, m, o, st, mine } = g;
    const viewing = viewId != null && g.m.matchup_id === viewId;
    const fin = st.state === 'fin';
    // an empty starting slot is the one fact about a lineup worth a tile's line before kickoff
    const holeOf = (R, mm) => { const stt = muStarters(R, mm), i2 = stt.findIndex(pid => !pid || pid === '0'); return i2 >= 0 ? `${slotLabel(starterSlots()[i2])} slot empty` : null; };
    const side = (R, mm, w, v, pj, lead, fav) => {
        const n = toPlay(R, mm);
        const k = st.state === 'proj' ? nextKick(R, mm) : null;
        // Final: the score is the fact — no odds, no "all played". Before kickoff the
        // kickoff time lives once, in the chyron, not on both team lines.
        const hole = st.state === 'proj' ? holeOf(R, mm) : null;
        const sub = fin ? null : (st.state !== 'proj' && n === 0) ? 'all played'
            : st.state === 'proj' ? `${n} to play${hole ? ' \u00b7 ' + hole : ''}`
                : [h('b', null, String(n)), ` to play · proj ${fmtS(pj)}`];
        return h('div', { class: 's6tr' },
            h('span', { class: `s6pct ${fav && !fin ? 's6f' : ''}`.trim(), title: fin ? null : 'Chance of winning' }, fin ? '' : `${w}%`),
            avatarEl(R, 'sm'),
            h('span', { class: 's6nmw' }, h('span', { class: `s6nm ${lead ? '' : 'lo'}`.trim(), title: teamName(R) }, teamName(R)), sub ? h('span', { class: 's6sub' }, sub) : null),
            h('span', { class: `s6sc mono ${lead ? '' : 'lo'}`.trim() }, fmtS(v)));
    };
    return h('div', { class: `s6cell ${mine ? 'me' : ''} ${viewing ? 'view' : ''}`.replace(/\s+/g, ' ').trim(), title: viewing ? 'On screen below' : 'Open this matchup', onclick: () => openGame(g) },
        h('div', { class: 's6top' }, mine ? h('span', { class: 's6you' }, 'YOUR GAME') : viewing ? h('span', { class: 's6view' }, 'VIEWING') : null, h('span', { class: `s6tag ${st.state}` }, muTag(st))),
        side(A, m, st.wX, st.vX, st.pX, st.vX >= st.vY, st.wX > 50),
        B ? side(B, o, 100 - st.wX, st.vY, st.pY, st.vY > st.vX, st.wX < 50)
            : h('div', { class: 's6tr' }, h('span'), h('span'), h('span', { class: 's6nm lo' }, 'Bye')),
        chyron(g));
}
// ── the four charts ──────────────────────────────────────────────────────────
const s6Head = (title, sub) => h('div', { class: 'card-h' }, h('h3', null, title), h('span', { class: 'dim', style: 'font-size:12px' }, sub));
const s6Ticks = (labels) => h('span', { class: 's6ticks' }, ...labels.map(([pos, txt]) => h('span', { style: `left:${pos}%` }, txt)));
const loadingLine = () => h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Reading this week’s plays…');
// Whose player, or whose play: yours, your opponent's, or neither. One gentle
// wash each, and every card uses this so the two colours mean one thing.
function hlOf(R) {
    if (!R || !S.myRoster) return '';
    if (R.roster_id === S.myRoster.roster_id) return 'hlme';
    const mm = myMatchup(S.week);
    return mm && mm.opp && R.roster_id === mm.opp.roster_id ? 'hlop' : '';
}
// "8:03p" — the time of day a play happened, under which its game clock sits.
function todTxt(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'a' : 'p'}`;
}
// The game behind a play: the scorer's team and the scoreline, his own number
// picked out in the same teal the points and the swing use.
// The game's score the moment after the play, the helped side first: what the
// play log's replay banked at that instant, not the score now. Two of one
// player's touchdowns read 138.87–78.47 both, which was the final, not either.
function gameScoreEl(p) {
    const st = p.g && p.g.st;
    if (!p.helped || (p.sa == null && !st)) return h('span', { class: 's6l2' }, p.helped ? teamName(p.helped) : '');
    const first = p.helped === p.g.A;
    const [x, y] = p.sa != null ? [p.sa, p.sb] : [st.vX, st.vY];
    return h('span', { class: 's6l2' }, teamName(p.helped), ' ',
        h('span', { class: 'gsc', title: p.sa != null ? 'The score right after this play' : 'The score now' }, '(', h('b', null, fmtS(first ? x : y)), '–', fmtS(first ? y : x), ')'));
}
// ── the week's box score, as atoms ───────────────────────────────────────────
// One phrase each, chosen and ordered by position, five at most: a quarterback's
// completions come off (nobody reads them), a defence counts sacks, turnovers,
// scores and points allowed. A kicker names his long makes only when the league
// pays for distance — one league adds +1 from 40 and +2 from 60, most add
// nothing — and tiers worth the same are merged, so 40-49 and 50-59 read "40+".
function statAtoms(pid) {
    const st = ((S.stats[S.week] || {})[pid] || {}).stats;
    if (!st) return [];
    const n = (k) => Math.round(st[k] || 0), pos = ppos(pid), out = [];
    if (pos === 'DEF') {
        if (st.sack) out.push(`${n('sack')} sck`);
        const to = n('int') + n('fum_rec'); if (to) out.push(`${to} TO`);
        const td = n('def_td') + n('st_td'); if (td) out.push(`${td} TD`);
        if (st.pts_allow != null) out.push(`${n('pts_allow')} PA`);
    } else if (pos === 'QB') {
        if (st.pass_att || st.pass_yd) out.push(`${n('pass_yd')} yds`);
        if (st.pass_td) out.push(`${n('pass_td')} TD`);
        if (st.pass_int) out.push(`${n('pass_int')} INT`);
        if (st.rush_att) out.push(`${n('rush_att')} car, ${n('rush_yd')} yds`);
        if (st.rush_td) out.push(`${n('rush_td')} rush TD`);
    } else if (pos === 'K') {
        out.push(`${n('fgm')}/${n('fga') || n('fgm')} FG`);
        const sc = (S.league && S.league.scoring_settings) || {};
        // Sleeper carries 50-59 and 50+ for the same kick; take whichever the
        // league actually scores, or a 53-yarder counts twice.
        const tiers = [['fgm_40_49', 40], [Number(sc.fgm_50_59) > 0 ? 'fgm_50_59' : 'fgm_50p', 50], ['fgm_60p', 60]];
        const groups = [];
        for (const [k, floor] of tiers) {
            const v = Number(sc[k] || 0); if (!(v > 0) || !st[k]) continue;
            const last = groups[groups.length - 1];
            if (last && last.v === v) last.n += n(k); else groups.push({ v, floor, n: n(k) });
        }
        for (const g of groups) if (g.n) out.push(`${g.n} from ${g.floor}+`);
        if (st.xpm) out.push(`${n('xpm')} XP`);
    } else {
        if (pos === 'RB' && st.rush_att) out.push(`${n('rush_att')} car, ${n('rush_yd')} yds`);
        if (pos === 'RB' && st.rush_td) out.push(`${n('rush_td')} TD`);
        if (st.rec || st.rec_tgt) out.push(`${n('rec')}/${n('rec_tgt') || n('rec')} rec, ${n('rec_yd')} yds`);
        if (st.rec_td) out.push(`${n('rec_td')}${st.rush_td ? ' rec' : ''} TD`);
        if (pos !== 'RB' && st.rush_att) out.push(`${n('rush_att')} car, ${n('rush_yd')} yds`);
    }
    if (st.fum_lost) out.push(`${n('fum_lost')} fum lost`);
    return out.slice(0, 5);
}
// Joined with REAL whitespace. Span boundaries alone give the browser nowhere to
// break, and the line overflows its column instead of wrapping to a second row.
function atomsEl(pid, cap) {
    const a = statAtoms(pid).slice(0, cap || 5), kids = [];
    a.forEach((t, i) => { if (i) kids.push(' ', h('i', { class: 's6mid' }, '·'), ' '); kids.push(h('span', { class: 's6at' }, t)); });
    return h('span', { class: 's6l3' }, ...kids);
}
const s6Lab = (l1, rest) => h('span', { class: 's6lab' }, h('span', { class: 's6l1' }, ...l1), ...rest.filter(Boolean));
// Latest plays, filterable BY GAME rather than by team: a touchdown is a play
// for the team that starts the scorer and against the team facing it, and the
// team facing it wants to see it. A team
// filter would hide exactly the plays that hurt you. Broken by kickoff window,
// the way the deep dive's play log is, so the time of day costs no column.
function latestCard(games, loading) {
    const sel = games.some(g => g.m.matchup_id === S.ui.sixGame) ? S.ui.sixGame : null;
    const all = games.flatMap(g => g.plays).sort((p, q) => q.t - p.t);
    const shown = (sel == null ? all : all.filter(p => p.g.m.matchup_id === sel)).slice(0, 40);
    const chip = (key, label, kids, mine) => h('span', { class: `gchip ${sel === key ? 'on' : ''} ${mine ? 'mine' : ''}`.replace(/\s+/g, ' ').trim(), title: label,
        onclick: () => { S.ui.sixGame = key; render(); } }, ...kids);
    const rows = []; let win = null;
    for (const p of shown) {
        const w = p.t ? gameSlot(p.t).n : null;
        if (w && w !== win) { rows.push(h('div', { class: 's6win' }, w)); win = w; }
        // The points and the odds it moved sit right after the play, not 400 px away.
        rows.push(h('div', { class: `lprow lp2 ${hlOf(p.helped)}`.trim(), title: p.desc, onclick: () => openGame(p.g) },
            h('span', { class: 'lpt mono' }, h('b', null, todTxt(p.t)), h('span', null, p.clock || '')),
            faceEl(p.pid, p.helped),
            s6Lab([h('b', null, pname(p.pid)), ` ${p.phrase}`,
                h('span', { class: `lpin mono ${p.dp > 0 ? 'up' : p.dp < 0 ? 'dn' : ''}`.trim(), title: 'Fantasy points this play' }, `${p.dp >= 0 ? '+' : '\u2212'}${fmtS(Math.abs(p.dp))}`),
                h('span', { class: `lpin mono w ${p.dw > 0 ? 'up' : p.dw < 0 ? 'dn' : ''}`.trim(), title: 'How far it moved the game\u2019s win %' }, `${p.dw > 0 ? '\u25b2' : p.dw < 0 ? '\u25bc' : ''}${Math.abs(p.dw * 100).toFixed(1)}%`),
                p.tot != null ? h('span', { class: 's6now mono', title: 'His points after this play' }, ` \u2192 ${fmtS(p.tot)}`) : null], [gameScoreEl(p)])));
    }
    // Chips say which game they are: "Yours" for your matchup, short names for the rest.
    const shortName = (R) => {
        const full = teamName(R);
        if (full.length <= 12) return full;   // "Team 2" is the whole name; its first word alone is every team
        const w = full.replace(/[^\w' ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
        const pick = w.length > 1 && w[w.length - 1].length >= 4 ? w[w.length - 1] : w[0] || full;
        return pick.length > 12 ? pick.slice(0, 11) + '\u2026' : pick;
    };
    return h('div', { class: 'card s6feed' }, s6Head('Latest plays', ''),
        h('div', { class: 'gchips' }, chip(null, 'Every game', ['All'], false),
            ...games.filter(g => g.B).map(g => chip(g.m.matchup_id, `${teamName(g.A)} v ${teamName(g.B)}`,
                [avatarEl(g.A, 'xs'), avatarEl(g.B, 'xs'), h('span', { class: 'gcn' }, g.mine ? 'Yours' : `${shortName(g.A)} v ${shortName(g.B)}`)], g.mine))),
        rows.length ? h('div', { class: 's6list', 'data-keep': 'sixfeed' }, ...rows)
            : loading ? loadingLine() : h('div', { class: 'empty' }, sel == null ? 'No play has moved a game yet.' : 'Nothing has moved this game yet.'));
}
// Biggest plays, as bars on one scale: a touchdown three times the next play
// should LOOK three times the next play before anyone reads a number. The two
// numbers sit in their own columns — a value printed on a bar was unreadable.
function biggestCard(games, loading) {
    const top = games.flatMap(g => g.plays).sort((p, q) => Math.abs(q.dw) - Math.abs(p.dw)).slice(0, 8);
    const head = s6Head('Biggest plays', 'how far one play moved a game’s win %');
    if (!top.length) return h('div', { class: 'card' }, head, loading ? loadingLine() : h('div', { class: 'empty' }, 'No play has moved a game yet.'));
    const max = Math.max(10, Math.ceil(Math.abs(top[0].dw) * 100 / 5) * 5);
    return h('div', { class: 'card' }, head,
        h('div', { class: 'bpaxis' }, h('span'), h('span'), s6Ticks([[0, '0%'], [50, `${max / 2}%`], [100, `${max}%`]]),
            h('span', { class: 's6colh' }, 'POINTS'), h('span', { class: 's6colh' }, 'WIN %')),
        ...top.map(p => {
            const w = Math.abs(p.dw) * 100 / max * 100;
            return h('div', { class: `bprow ${hlOf(p.helped)}`.trim(), title: `${p.desc}${p.clock ? ' · ' + p.clock : ''}`, onclick: () => openGame(p.g) },
                faceEl(p.pid, p.helped),
                s6Lab([h('b', null, pname(p.pid)), ` ${p.phrase}`, p.tot != null ? h('span', { class: 's6now mono', title: 'His points after this play' }, ` \u2192 ${fmtS(p.tot)}`) : null], [gameScoreEl(p)]),
                h('span', { class: 'bpplot' }, ...[0, 50, 100].map(x => h('span', { class: 'bpgrid', style: `left:${x}%` })),
                    h('span', { class: `bpbar ${p.dw < 0 ? 'dn' : ''}`.trim(), style: `width:${w}%` })),
                h('span', { class: `lppts mono ${p.dp > 0 ? 'up' : p.dp < 0 ? 'dn' : ''}`.trim() }, `${p.dp >= 0 ? '+' : '−'}${fmtS(Math.abs(p.dp))}`, h('small', null, 'pts')),
                h('span', { class: `lpd mono ${p.dw > 0 ? 'up' : p.dw < 0 ? 'dn' : ''}`.trim() }, pctTxt(p.dw)));
        }));
}
const POS_VAR = { QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', K: 'k', DEF: 'def' };
function scorersCard(started) {
    const top = started.filter(x => x.pts > 0).sort((p, q) => q.pts - p.pts).slice(0, 8);
    const head = s6Head('Top scorers', 'anyone in the league');
    if (!top.length) return h('div', { class: 'card' }, head, h('div', { class: 'empty' }, 'Nobody has scored yet this week.'));
    const pick = (x) => () => { S.ui.sel = x.pid; render(); };
    return h('div', { class: 'card' }, head,
        h('div', { class: 'podium' }, ...top.slice(0, 3).map((x, i) => h('div', { class: `pod ${hlOf(x.R)}`.trim(), style: `--c:var(--${POS_VAR[ppos(x.pid)] || 'line-2'})`, onclick: pick(x) },
            h('div', { class: 'podrk' }, ['1ST', '2ND', '3RD'][i], ' · ', h('span', { class: `pos txt ${ppos(x.pid)}` }, posLabel(ppos(x.pid)))),
            h('img', { class: 'podface', src: headshot(x.pid), alt: '', loading: 'lazy', onerror: hideBroken }),
            h('div', { class: 'podn', title: pname(x.pid) }, pname(x.pid)),
            h('div', { class: 'podv mono' }, fmtS(x.pts)),
            // three atoms on the podium: those cards are a third of a row's width
            h('div', { class: 'pods' }, atomsEl(x.pid, 3)),
            h('div', { class: 'podown' }, avatarEl(x.R, 'xs'), h('span', null, teamName(x.R)))))),
        h('div', { class: 's6scroll' }, ...top.slice(3).map((x, i) => h('div', { class: `tsrow ${hlOf(x.R)}`.trim(), title: teamName(x.R), onclick: pick(x) },
            h('span', { class: 'tsrk mono' }, String(i + 4)), faceEl(x.pid, x.R),
            s6Lab([h('b', null, pname(x.pid)), ' ', h('span', { class: `pos txt ${ppos(x.pid)}` }, posLabel(ppos(x.pid)))],
                [h('span', { class: 's6l2' }, teamName(x.R)), atomsEl(x.pid)]),
            h('span', { class: 'tsv mono' }, fmtS(x.pts))))));
}
// Over / under performers: every started player against his projection, either
// way. Measured against his PACE, not his full-game number: a star whose game
// has just kicked off is expected to have about nothing yet, so he sits on the
// line instead of at −19. Halfway through he is held to half of it; at the
// final whistle, to all of it. Players projected under 6 stay out, or a backup
// 0.4 under would top the list. A D/ST waits for its final whistle: its points-
// and yards-allowed bonus counts in full from kickoff while the pace grows with
// the clock, so mid-game every defence read as a big beat (2026-10-18: PIT 12.75
// against "2.4", the user asking why the D/ST projections were all so low).
function overUnderCard(started, opts) {
    const liveDst = started.filter(x => ppos(x.pid) === 'DEF' && x.played > 0 && x.played < 1).length;
    const all = started.filter(x => x.proj >= 6 && x.played > 0 && !(ppos(x.pid) === 'DEF' && x.played < 1))
        .map(x => { const exp = x.proj * x.played; return { ...x, exp, gap: x.pts - exp }; })
        .filter(x => Math.abs(x.gap) >= 0.5);
    const head = s6Head('Over / under performers', (opts && opts.sub) || 'against his projection so far');
    if (!all.length) return h('div', { class: 'card' }, head, h('div', { class: 'empty' }, started.length ? 'Everyone who has played is on his projection.' : 'Nothing has kicked off yet.'));
    // Beats and misses are not the same size — a miss can be a whole projection,
    // a beat rarely doubles one — so a single list by size buries the beats.
    // Two labelled runs, and a filter that shows one of them on its own.
    const f = S.ui.ouFilter === 'over' || S.ui.ouFilter === 'under' ? S.ui.ouFilter : 'both';
    const over = all.filter(x => x.gap >= 0).sort((p, q) => q.gap - p.gap);
    const under = all.filter(x => x.gap < 0).sort((p, q) => p.gap - q.gap);
    const max = Math.max(12, Math.ceil(Math.max(...all.map(x => Math.abs(x.gap))) * 1.45));
    const half = (v) => Math.min(50, Math.abs(v) / max * 50);
    const row = (x) => {
        const w = half(x.gap), isOver = x.gap >= 0, live = x.played < 1;
        return h('div', { class: `ourow ${hlOf(x.R)}`.trim(), title: `${pname(x.pid)}: ${fmt1(x.pts)} scored, ${fmt1(x.exp)} expected by now, ${fmt1(x.proj)} for the game`, onclick: () => { S.ui.sel = x.pid; render(); } },
            faceEl(x.pid, x.R),
            s6Lab([h('b', null, pname(x.pid))], [h('span', { class: 's6l2' }, teamName(x.R)), atomsEl(x.pid)]),
            h('span', { class: 'oudv' }, h('span', { class: 'ougrid zero', style: 'left:50%' }),
                h('span', { class: `oubar ${isOver ? 'up' : 'dn'}`, style: `${isOver ? 'left' : 'right'}:50%;width:${w}%` }),
                h('span', { class: `ouval mono ${isOver ? 'up' : 'dn'}`, style: `${isOver ? 'left' : 'right'}:calc(${50 + w}% + 5px)` }, `${isOver ? '+' : '−'}${fmt1(Math.abs(x.gap))}`)),
            h('span', { class: `ouact mono ${isOver ? 'up' : 'dn'}` }, fmtS(x.pts), live ? h('i', { class: 'oulive', title: 'still playing' }) : null),
            h('span', { class: 'ouproj mono' }, fmt1(x.exp), live ? h('small', null, `of ${fmt1(x.proj)}`) : null));
    };
    const chip = (k, label, n) => h('span', { class: k === f ? 'on' : '', onclick: (e) => { e.stopPropagation(); S.ui.ouFilter = k; render(); } }, label, h('i', null, ` ${n}`));
    const rows = [];
    if (f !== 'under' && over.length) { if (f === 'both') rows.push(h('div', { class: 's6grp up' }, 'BEATING THEIR PROJECTION')); rows.push(...over.map(row)); }
    if (f !== 'over' && under.length) { if (f === 'both') rows.push(h('div', { class: 's6grp dn' }, 'MISSING IT')); rows.push(...under.map(row)); }
    return h('div', { class: 'card s6feed' }, head,
        h('div', { class: 'seg ouseg' }, chip('both', 'Both', all.length), chip('over', 'Over', over.length), chip('under', 'Under', under.length)),
        h('div', { class: 'ouaxis' }, h('span'), h('span'), s6Ticks([[0, 'under'], [50, 'on pace'], [100, 'over']]),
            h('span', { class: 's6colh' }, 'ACT'), h('span', { class: 's6colh', title: 'His projection for the share of his game played so far; under it, his projection for the whole game' }, 'BY NOW')),
        rows.length ? h('div', { class: 's6list', 'data-keep': (opts && opts.keep) || 'sixou' }, ...rows)
            : h('div', { class: 'empty' }, f === 'over' ? 'Nobody is beating his projection yet.' : 'Nobody is missing his projection.'),
        liveDst ? h('div', { class: 'cap ounote' }, `${liveDst === 1 ? 'One D/ST joins' : `${liveDst} D/STs join`} when ${liveDst === 1 ? 'its game ends' : 'their games end'}: points and yards allowed only settle at the final whistle.`) : null);
}
function allSixPage() {
    const page = h('div', { class: 'page allsix' });
    const games = sixGames();
    // every tile opens its game; none is "viewing" here (map's index would pass for a matchup id)
    page.append(h('div', { class: 'card span2' }, h('div', { class: 'wall' }, ...games.map((g2) => sixCell(g2)))));
    const started = leagueStarters().filter(x => x.started);
    // Six days a week there is no football, and four empty charts are worse
    // than none: before anything kicks off, the whole lower half is one line.
    if (!started.length && !games.some(g => g.plays.length)) {
        page.append(h('div', { class: 'card span2' }, h('div', { class: 'cap', style: 'margin:0' }, 'Nothing has kicked off yet. Plays, scorers and over/unders fill in here once it has.')));
        return page;
    }
    const loading = !S.plays[S.week] && S.week >= S.curWeek;
    // Once every game is final, the week's story leads: the biggest plays and who beat
    // their projection. On a live Sunday, Latest plays stays first.
    const allFinal = games.length && games.every(g => g.st && g.st.state === 'fin');
    if (allFinal) page.append(biggestCard(games, loading), overUnderCard(started), scorersCard(started), latestCard(games, loading));
    else page.append(latestCard(games, loading), biggestCard(games, loading), scorersCard(started), overUnderCard(started));
    return page;
}
// ── Scoreboard · NFL games ───────────────────────────────────────────────────
// The real games, with the fantasy read on every play. The slate down the side
// says how much of YOUR matchup is in each game; the game in the middle shows
// the score, the field while it is live, who in this league has players in it,
// and the plays grouped into drives with what each did in this league's
// scoring and whose player it was. Everything is Sleeper's: the scores feed
// (quarters, possession, down and distance, spread, weather), the play feed the
// play log already pulls, and Sleeper's per-game box score. Sleeper has no
// drive list, so drives are rebuilt from changes of possession.
const GC_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);
const GC_NOPOS = new Set(['kickoff', 'extra_point', 'two_point', 'timeout', 'end_period', 'end_half', 'two_minute_warning', 'game_over']);
// Sleeper names kickoffs kickoff, kickoff_touchback, kickoff_muffed… and two-point tries conversion_pass,
// conversion_rush… (never two_point): each began a one-play drive of its own until 2026-10-24.
const gcNoPos = (t) => GC_NOPOS.has(t) || /^(kickoff|conversion)/.test(t || '');
const teamLogo = (t) => `https://sleepercdn.com/images/team_logos/nfl/${String(t).toLowerCase()}.png`;
const teamNick = (t) => { const d = S.players && S.players[t]; return (d && d.last_name && d.last_name !== 'D/ST' ? d.last_name : null) || t; };
function nflGames() {
    const seen = new Set(), out = [];
    for (const r of Object.values(kickMap() || {})) if (r && r.gid && !seen.has(r.gid)) { seen.add(r.gid); out.push(r); }
    return out.sort((a, b) => String(a.t).localeCompare(String(b.t)) || a.home.localeCompare(b.home));
}
// Your starters and your opponent's, per game: what the slate sorts on.
function gcStake(g) {
    const mm = myMatchup(S.week), my = S.myRoster;
    const oppR = mm && mm.opp ? rosterById(mm.opp.roster_id) : null;
    const inGame = (pid) => { const tm = (P(pid) || {}).team; return tm === g.home || tm === g.away; };
    const starters = (m, R) => ((m && m.starters) || (R && R.starters) || []).filter(p => p && p !== '0' && inGame(p));
    return { mine: my ? starters(mm && mm.mine, my) : [], opps: oppR ? starters(mm.opp, oppR) : [], oppR };
}
// A play's text with each player's name in bold, coloured by whose he is in this league: yours teal, your
// opponent's blue, anyone else plain (the user, 2026-10-25: no free-agent colour here). Sleeper writes a name as
// initial, dot, last name ("J.Love", "A.St. Brown") and leaves off the Jr./Sr. its own last_name carries.
const GC_NAME = /\b[A-Z][A-Za-z]{0,2}\.(?:St\. )?[A-Z][A-Za-z'\-]+(?: (?:Jr|Sr|II|III|IV)\b\.?)?/g;
const GC_SUFFIX = /\s+(?:Jr|Sr|II|III|IV|V)\.?$/;
function gcDescNames(desc, p, oppR) {
    const ids = playStatsOf(p).map((x) => String(x.player_id)).filter((x) => /^\d+$/.test(x));
    const whose = (nm) => {
        const last = nm.slice(nm.indexOf('.') + 1).replace(GC_SUFFIX, '');
        const pid = ids.find((x) => { const d = P(x) || {}; return (d.last_name || '').replace(GC_SUFFIX, '') === last && (d.first_name || '')[0] === nm[0]; });
        const o = pid ? gcOwner(pid, oppR) : null;
        return o && (o.cls === 'me' || o.cls === 'opp') ? o.cls : '';
    };
    const text = desc || '', out = []; let i = 0;
    for (const mt of text.matchAll(GC_NAME)) {
        if (mt.index > i) out.push(text.slice(i, mt.index));
        const c = whose(mt[0]); out.push(h('b', { class: `gcnm${c ? ' ' + c : ''}` }, mt[0])); i = mt.index + mt[0].length;
    }
    if (i < text.length) out.push(text.slice(i));
    return out;
}
function gcOwner(pid, oppR) {
    const R = ownerOf(pid);
    if (!R) return { cls: 'fa', label: 'FA' };
    if (S.myRoster && R.roster_id === S.myRoster.roster_id) return { cls: 'me', label: 'YOURS', R };
    if (oppR && R.roster_id === oppR.roster_id) return { cls: 'opp', label: 'THEIRS', R };
    return { cls: 'oth', label: teamName(R), R };
}
// A play's fantasy effect: each skill player's stats on it, in this league's scoring,
// and each defence's credits (sacks, takeaways, return scores) for whoever rosters that
// D/ST — the same mapping the matchup ledger uses. Points and yards allowed are brackets
// that only settle at the whistle, so they stay out of a single play's chip.
function gcPlayFx(p) {
    const out = [], def = {}, md = p.metadata || {};
    const credit = (team, k, v) => { if (!team || typeof v !== 'number' || /^(pts_allow|yds_allow)/.test(k)) return; (def[team] = def[team] || {})[k] = (def[team][k] || 0) + v; };
    const rows = playStatsOf(p);
    for (const [team, k, v] of defCredits(rows, md)) credit(team, k, v);
    for (const s of rows) {
        const pid = String(s.player_id), st = s.stats || {};
        if (!/^\d+$/.test(pid)) { for (const k in st) if ((S.league.scoring_settings || {})[k] != null) credit(pid, k, st[k]); continue; }   // a team row
        if (!GC_POS.has(ppos(pid))) continue;
        const v = scoreStats(st); if (v == null || Math.abs(v) < 0.05) continue;
        out.push({ pid, pts: Math.round(v * 100) / 100 });
    }
    for (const [team, st] of Object.entries(def)) { const v = scoreStats(st); if (v != null && Math.abs(v) >= 0.05) out.push({ pid: team, pts: Math.round(v * 100) / 100 }); }
    return out;
}
function gcDrives(plays) {
    const drives = []; let cur = null;
    for (const p of plays) {
        const m = p.metadata || {};
        // a kickoff always starts a new drive, even when the same team gets the ball back (a
        // defensive score, an onside kick) — otherwise a pick-six vanishes into the next series
        if (/^kickoff/.test(m.play_type || '')) { if (cur) { cur.after.push(p); cur.closed = true; } continue; }
        if (!m.possession || gcNoPos(m.play_type)) { if (cur) cur.after.push(p); continue; }
        if (!cur || cur.closed || cur.pos !== m.possession) { cur = { pos: m.possession, q: m.quarter_name, plays: [], after: [] }; drives.push(cur); }
        cur.plays.push(p);
        if (m.is_scoring_play) cur.closed = true;
    }
    const clk = (m) => `${m.time_remaining_minutes ?? 0}:${String(m.time_remaining_seconds ?? 0).padStart(2, '0')}`;
    const gsec = (m) => { const q = quarterNum(m.quarter_name) || 5; return (q - 1) * 900 + ((q > 4 ? 600 : 900) - ((m.time_remaining_minutes || 0) * 60 + (m.time_remaining_seconds || 0))); };   // overtime is ten minutes
    drives.forEach((d, i) => {
        const first = d.plays[0].metadata, last = d.plays[d.plays.length - 1].metadata, next = drives[i + 1];
        d.key = `${d.pos}:${first.sequence}`;
        d.start = clk(first); d.startYl = `${first.yard_line_territory || ''} ${first.yard_line ?? ''}`.trim();
        d.n = d.plays.filter(p => !/no_play/.test(p.metadata.play_type)).length;
        d.yds = d.plays.reduce((t, p) => t + (/no_play|punt|field_goal|kneel/.test(p.metadata.play_type) ? 0 : (p.metadata.yards_gained || 0)), 0);
        d.dur = Math.max(0, (next ? gsec(next.plays[0].metadata) : gsec(last) + 20) - gsec(first));
        const tail = d.after.map(p => p.metadata.play_type).join(' '), desc = last.description || '';
        // a score by the other side is a takeaway returned, not this offence's touchdown
        const theirs = last.is_scoring_play && last.scoring_team && last.scoring_team !== d.pos;
        d.result = theirs ? (/safety/i.test(desc) ? 'Safety' : /INTERCEPTED/i.test(desc) ? 'Interception returned for a TD' : 'Fumble returned for a TD')
            : last.is_scoring_play && /field_goal/.test(last.play_type) ? 'Field goal' : last.is_scoring_play ? 'Touchdown'
            : /punt/.test(last.play_type) ? 'Punt' : /INTERCEPTED/i.test(desc) ? 'Interception' : /FUMBLES/i.test(desc) && next && next.pos !== d.pos ? 'Fumble'
            : /field_goal/.test(last.play_type) ? 'Missed field goal' : /kneel/.test(last.play_type) || /game_over/.test(tail) ? 'End of game'
            : (last.quarter_name === '2' && next && next.q === '3') || /end_half/.test(tail) ? 'End of half' : last.down === 4 && next ? 'Turnover on downs' : next ? 'End of half' : 'In progress';
        d.fx = {};
        for (const p of d.plays.concat(d.after)) for (const x of gcPlayFx(p)) d.fx[x.pid] = Math.round(((d.fx[x.pid] || 0) + x.pts) * 100) / 100;
    });
    return drives;
}
// Sleeper's box score for one game: team totals and every player's line.
async function loadGameBox(g, nPlays) {
    S.gcBox = S.gcBox || {};
    const cur = S.gcBox[g.gid];
    // resolves true only when it fetched: the caller re-renders on that, and only on that
    if (cur && (cur.final || (cur.n === nPlays && Date.now() - cur.at < 60e3))) return false;
    if (S.gcBoxBusy) return false;
    S.gcBoxBusy = true;
    try {
        const d = await gql('game_stats', `query game_stats { game_stats(sport: "nfl", season: "${S.season}", season_type: "regular", game_id: "${g.gid}", category: "stat", order_by: "pts_ppr"){ player_id team stats } }`);
        S.gcBox[g.gid] = { at: Date.now(), n: nPlays, final: !!g.over, list: d.game_stats || [] };
        return true;
    } catch (e) { console.warn(TAG, 'game box:', e.message); S.gcBox[g.gid] = { at: Date.now(), n: nPlays, final: false, list: (cur && cur.list) || [] }; return false; }
    finally { S.gcBoxBusy = false; }
}
function gcChip(pid, pts, oppR) {
    const o = gcOwner(pid, oppR), ln = ppos(pid) === 'DEF' ? `${pid} D/ST` : (P(pid) || {}).last_name || pname(pid);
    return h('span', { class: `gcchip ${o.cls} ${pts < 0 ? 'neg' : ''}`, title: `${pname(pid)} · ${o.cls === 'fa' ? 'available in your league' : o.label === 'YOURS' ? 'your player' : o.label === 'THEIRS' ? `${teamName(o.R)} (your opponent)` : o.label}`, role: 'button', tabindex: '0', onclick: (e) => { e.stopPropagation(); S.ui.sel = pid; render(); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); S.ui.sel = pid; render(); } } },
        h('img', { class: 'gcchf', src: ppos(pid) === 'DEF' ? teamLogo(pid) : headshot(pid), alt: '', onerror: hideBroken }), ln, ' ', h('b', null, `${pts > 0 ? '+' : pts < 0 ? '−' : ''}${fmtS(Math.abs(pts))}`));
}
function gcPickDefault(games) {
    const stake = (g) => { const s = gcStake(g); return s.mine.length * 2 + s.opps.length; };
    const live = games.filter(g => g.live).sort((a, b) => stake(b) - stake(a));
    if (live.length) return live[0];
    const soon = games.filter(g => !g.over && !g.live && stake(g)).sort((a, b) => String(a.t).localeCompare(String(b.t)));
    if (soon.length) return soon[0];
    const fin = games.filter(g => g.over).sort((a, b) => stake(b) - stake(a) || String(b.t).localeCompare(String(a.t)));
    return fin[0] || games[0];
}
function gameCenterPage() {
    const page = h('div', { class: 'page gcx' });
    const games = nflGames();
    if (!games.length) { page.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, S.kick ? `No NFL games found for week ${S.week}.` : 'Loading the week’s games…'))); return page; }
    let g = games.find(x => x.gid === S.ui.gcGame);
    if (!g) { g = gcPickDefault(games); S.ui.gcGame = g.gid; }
    const { mine: myStarters, opps: oppStarters, oppR } = gcStake(g);
    const rec = S.plays[S.week];
    const plays = rec && rec.list ? rec.list.filter(p => p.game_id === g.gid).slice().sort((x, y) => (x.metadata.sequence || 0) - (y.metadata.sequence || 0)) : [];
    if (g.live || g.over) loadGameBox(g, plays.length).then((got) => { if (got) render(); }).catch(() => {});
    const box = (S.gcBox || {})[g.gid];
    const kick = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
    const day = (t) => new Date(t).toLocaleDateString('en-US', { weekday: 'long' });
    // ── the slate
    const slot = (x) => x.over ? `${day(x.t)} · Final` : `${day(x.t)} ${kick(x.t)}`;
    const groups = []; for (const x of games) { const k = x.live ? 'Live now' : slot(x); let gr = groups.find(z => z.k === k); if (!gr) { gr = { k, list: [] }; groups.push(gr); } gr.list.push(x); }
    groups.sort((a, b) => (b.k === 'Live now') - (a.k === 'Live now'));
    const rail = h('div', { class: 'gcrail' });
    for (const gr of groups) {
        rail.append(h('h4', null, gr.k));
        gr.list.sort((a, b) => { const sa = gcStake(a), sb = gcStake(b); return (sb.mine.length + sb.opps.length) - (sa.mine.length + sa.opps.length); });
        for (const x of gr.list) {
            const st = gcStake(x), started = x.live || x.over;
            const dots = (n, c) => n ? h('span', null, ...Array.from({ length: n }, () => h('i', { class: `gcdot ${c}` })), ` ${n} ${c === 'me' ? 'yours' : 'theirs'}`) : null;
            rail.append(h('div', { class: `gcrg ${x.gid === g.gid ? 'on' : ''}`, onclick: () => { S.ui.gcGame = x.gid; S.ui.gcOpen = null; render(); } },
                h('img', { class: 'gclogo', src: teamLogo(x.away), alt: '' }), h('div', { class: `t ${started && x.as > x.hs ? 'win' : ''}` }, h('span', null, x.away), h('span', { class: 'mono' }, started ? x.as : '')),
                h('div', { class: 'gst mono' }, x.over ? 'FINAL' : x.live ? `● ${quarterLabel(x)}` : kick(x.t), !started && x.ch ? h('small', null, x.ch) : null),
                h('img', { class: 'gclogo', src: teamLogo(x.home), alt: '' }), h('div', { class: `t ${started && x.hs > x.as ? 'win' : ''}` }, h('span', null, x.home), h('span', { class: 'mono' }, started ? x.hs : '')),
                h('div', { class: 'stake mono' }, dots(st.mine.length, 'me'), dots(st.opps.length, 'opp'), !st.mine.length && !st.opps.length ? 'no starters in your matchup' : null)));
        }
    }
    // ── the score bug
    const qRow = (t, qs, tot) => h('tr', null, h('td', null, t), ...[0, 1, 2, 3].map(i => h('td', null, started2 ? (qs[i] ?? '–') : '–')), h('td', { class: 't' }, started2 ? tot : '–'));
    const started2 = g.live || g.over;
    const side = (t, rec2, sc, home, lose) => h('div', { class: `gcside ${home ? 'home' : ''}` },
        home ? h('div', { class: `sc mono ${lose ? 'lose' : ''}` }, started2 ? sc : '') : null,
        home ? null : h('img', { class: 'gclogo lg', src: teamLogo(t), alt: '' }),
        // Sleeper's record lags the game it just finished; 0-0-0 is never worth a line
        h('div', null, h('div', { class: 'nm' }, teamNick(t)), (() => { const r2 = rec2 && !/^0-0(-0)?$/.test(String(rec2).trim()) ? rec2 : ''; return h('div', { class: 'rec mono' }, `${r2}${r2 ? ' · ' : ''}${home ? 'home' : 'away'}`); })()),
        home ? h('img', { class: 'gclogo lg', src: teamLogo(t), alt: '' }) : null,
        home ? null : h('div', { class: `sc mono ${lose ? 'lose' : ''}` }, started2 ? sc : ''));
    const status = g.over ? h('span', { class: 'fin' }, 'FINAL') : g.live ? h('span', { class: 'live' }, `● ${g.q === 'H' ? 'HALFTIME' : `${quarterLabel(g)} ${g.tr || ''}`.trim()}`) : h('span', { class: 'pre' }, `${day(g.t)} ${kick(g.t)}`);
    const bug = h('div', { class: 'gcbug' }, side(g.away, g.arec, g.as, false, g.over && g.as < g.hs),
        h('div', { class: 'gcmid' }, status, h('table', { class: 'gcqt' }, h('tr', null, h('th'), ...['1', '2', '3', '4', 'T'].map(x => h('th', null, x))), qRow(g.away, g.aq || [], g.as), qRow(g.home, g.hq || [], g.hs))),
        side(g.home, g.hrec, g.hs, true, g.over && g.hs < g.as));
    const fav = g.spread ? Object.entries(g.spread).filter(([k]) => /^[A-Z]{2,3}$/.test(k)).sort((a, b) => a[1] - b[1])[0] : null;
    const meta = h('div', { class: 'gcmeta' },
        h('span', null, h('b', null, new Date(g.t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })), g.ch ? ` · ${g.ch}` : ''),
        g.stadium ? h('span', null, g.stadium) : null,
        g.weather ? h('span', null, `${g.weather}${g.temp != null ? `, ${g.temp}°` : ''}`) : null,
        fav ? h('span', null, `Line: ${fav[0]} ${fav[1] > 0 ? '+' : ''}${fav[1]}`) : null);
    // ── the field, while it is live
    const lastPlay = plays.length ? plays[plays.length - 1].metadata : null;
    let field = null;
    if (g.live && lastPlay) {
        const pos = g.pos || lastPlay.possession, def = pos === g.home ? g.away : g.home;
        const ylt = g.ylt || lastPlay.yard_line_territory_end, yl = g.yl !== '' && g.yl != null ? Number(g.yl) : lastPlay.yard_line_end;
        // down and distance from the score line first, else the last real play (a TV timeout carries neither)
        const snap = (plays.findLast((p) => p.metadata.play_type) || { metadata: {} }).metadata, st = snap.play_type || '';
        const ddm = /&\s*(\d+)/.exec(g.dd || ''), down = g.down || snap.down_end, dist = ddm ? Number(ddm[1]) : snap.distance_end;
        if (pos && ylt && yl != null && !isNaN(yl)) {
            const ownYds = ylt === pos ? yl : 100 - yl, X = (y) => 8.33 + Math.max(0, Math.min(100, y)) / 100 * 83.34;
            const drives0 = gcDrives(plays), lastD = drives0[drives0.length - 1], curD = lastD && lastD.pos === pos && lastD.result === 'In progress' ? lastD : null;
            const startYds = curD ? (curD.plays[0].metadata.yard_line_territory === pos ? curD.plays[0].metadata.yard_line : 100 - curD.plays[0].metadata.yard_line) : ownYds;
            const goal = dist != null && (100 - ownYds) <= dist;
            // after a touchdown's try or a made field goal the next snap is a kickoff, not a down
            const kickNext = !down && (/^(extra_point|conversion)/.test(st) || (/^field_goal/.test(st) && !!snap.is_scoring_play));
            field = h('div', { class: 'gcfield-wrap' },
                // a real field (the user, 2026-10-25): ten 10-yard bands between the goal lines, a line every ten,
                // midfield, the yard numbers, and both red zones (inside each 20) as a red shade of the turf. The
                // offense always drives right.
                h('div', { class: 'gcfield' },
                    h('span', { class: 'yds' }, [10, 20, 30, 40, 50, 40, 30, 20, 10].map((n, i) => h('i', { style: `left:${(i + 1) * 10}%` }, n))),
                    h('span', { class: 'ez l' }, pos), h('span', { class: 'ez r' }, def),
                    h('span', { class: 'drv', style: `left:${Math.min(X(startYds), X(ownYds))}%;width:${Math.abs(X(ownYds) - X(startYds))}%` }),
                    h('span', { class: 'los', style: `left:${X(ownYds)}%` }), dist && !goal ? h('span', { class: 'fdm', style: `left:${X(ownYds + dist)}%` }) : null,
                    h('span', { class: 'ball', style: `left:${X(ownYds)}%` })),
                h('div', { class: 'gcdnd' }, h('b', { class: 'mono' }, g.dd || (down ? `${['', '1st', '2nd', '3rd', '4th'][down]} & ${goal ? 'Goal' : dist}` : kickNext ? `${pos} to kick off` : `${pos} ball`)), h('span', null, `${kickNext && !down ? 'from' : 'at'} ${ylt} ${yl}`),
                    (g.rz || (ylt === def && yl <= 20)) ? h('span', { class: 'rz' }, 'RED ZONE') : null));
        }
    }
    // ── play by play, under the score (the user, 2026-10-25, picked C): every drive in a list on the left, newest
    // first, and the open drive on the right: a labelled total (it reads as the drive, not as one more play), then
    // its plays newest first, six of them with the rest one press away, each with its gain. The field above
    // already says what is happening now, so nothing here repeats it.
    const drives = gcDrives(plays);
    if (S.ui.gcDrvFor !== g.gid) { S.ui.gcDrvFor = g.gid; S.ui.gcDrv = null; S.ui.gcMore = false; }
    const di = S.ui.gcDrv == null || S.ui.gcDrv >= drives.length ? drives.length - 1 : S.ui.gcDrv, d = drives[di];
    const resTag = (d) => d.result === 'Touchdown' ? ['td', 'TD'] : d.result === 'Field goal' ? ['fg', 'FG'] : /^Interception/.test(d.result) ? ['to', 'INT'] : /^Fumble/.test(d.result) ? ['to', 'FUM'] : d.result === 'Safety' ? ['to', 'SAFETY'] : d.result === 'Turnover on downs' ? ['to', 'DOWNS'] : d.result === 'In progress' ? ['live', 'LIVE'] : /^End/.test(d.result) ? ['end', 'END'] : ['punt', d.result === 'Missed field goal' ? 'MISS' : 'PUNT'];
    const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    // the newest drive is held as null, so a new drive replaces it on screen as it starts
    const tap = (fn, focus) => ({ role: 'button', tabindex: '0', 'data-focus': focus, onclick: fn, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } } });
    const goDrv = (n) => { S.ui.gcDrv = n >= drives.length - 1 ? null : n; S.ui.gcMore = false; render(); };
    const drvName = (x) => `${x.pos} ${x.result === 'In progress' ? 'drive in progress' : x.result}`;
    // what the play gained, in a word where yards don't say it
    const gainOf = (m) => { const t = m.play_type || '';
        if (!t) return ['', ''];
        if (/no_play/.test(t) || t === 'penalty') return ['PEN', 'pen'];
        if (/spike/i.test(m.description || '')) return ['spike', 'z'];
        if (/interception/.test(t)) return ['INT', 'dn'];
        if (/^pass_incomplete/.test(t) && !/sacked/.test(t)) return ['inc', 'z'];
        if (/^punt/.test(t)) return ['punt', 'z'];
        if (/^kickoff/.test(t)) return ['kickoff', 'z'];
        if (/^(field_goal|extra_point|conversion)/.test(t)) return [m.is_scoring_play ? (/^field/.test(t) ? 'FG' : /^extra/.test(t) ? 'PAT' : '2-PT') : 'no good', 'z'];
        const y = m.yards_gained || 0;
        return y > 0 ? [`▲ +${y}`, 'up'] : y < 0 ? [`▼ −${-y}`, 'dn'] : ['0', 'z']; };
    const playRow = (p) => {
        const m = p.metadata, pfx = gcPlayFx(p), [gn, gc] = gainOf(m);
        const goal = m.yards_to_end_zone != null && m.distance != null && m.yards_to_end_zone <= m.distance;
        const dd = m.down ? `${['', '1st', '2nd', '3rd', '4th'][m.down]} & ${goal ? 'Goal' : m.distance}` : /^conversion/.test(m.play_type || '') ? '2-PT' : /extra_point/.test(m.play_type) ? 'PAT' : '';
        const at = m.play_type && m.yard_line != null ? `${m.yard_line_territory || ''} ${m.yard_line}`.trim() : '';
        return h('div', { class: `gcplay ${m.is_scoring_play ? 'sc' : ''} ${/INTERCEPTED|FUMBLES/i.test(m.description || '') ? 'bad' : ''}` },
            h('span', { class: 'cl mono' }, `${playQuarter(m.quarter_name)} ${m.time_remaining_minutes ?? ''}:${String(m.time_remaining_seconds ?? 0).padStart(2, '0')}`),
            h('span', { class: 'dd mono' }, dd, at ? h('em', null, at) : null),
            h('div', { class: 'dsw' }, h('span', { class: 'ds' }, ...gcDescNames(m.description, p, oppR)), pfx.length ? h('div', { class: 'fx' }, ...pfx.map(x => gcChip(x.pid, x.pts, oppR))) : null),
            h('span', { class: `gn mono ${gc}` }, gn));
    };
    let pbp;
    if (!d) pbp = h('div', { class: 'card gcpbp' }, h('div', { class: 'gcpbh' }, h('h3', null, 'Play by play')), h('div', { class: 'gcnone' }, started2 ? 'No plays yet.' : `No plays yet: it kicks off ${day(g.t)} ${kick(g.t)}.`));
    else {
        const all = d.plays.concat(d.after).sort((a, b) => (b.metadata.sequence || 0) - (a.metadata.sequence || 0)), shown = S.ui.gcMore ? all : all.slice(0, 6), [rc, rl] = resTag(d);
        const live = g.live && di === drives.length - 1 && d.result === 'In progress', head = live ? 'In progress' : d.result;
        const cell = (k, v) => h('div', { class: 'cell' }, h('span', null, k), h('b', { class: 'mono' }, v));
        pbp = h('div', { class: 'card gcpbp' },
            h('div', { class: 'gcpbh' }, h('h3', null, 'Play by play'), h('span', { class: 'shm' }, 'newest first · press a drive to open it')),
            h('div', { class: 'gccg' },
                h('div', { class: 'gcdcol' }, h('div', { class: 'gcdlh' }, `Drives · ${drives.length}`),
                    h('div', { class: 'gcdls', 'data-keep': `gcdrives-${g.gid}` }, ...drives.map((x, n) => n).reverse().map((n) => {
                        const x = drives[n], [c2, l2] = resTag(x);
                        return h('div', { class: `gcdl ${n === di ? 'on' : ''}`, 'data-drive': n, 'aria-current': n === di ? 'true' : null, title: drvName(x), ...tap(() => goDrv(n), `gcdl:${n}`) },
                            h('img', { class: 'gclogo', src: teamLogo(x.pos), alt: '' }),
                            h('div', { class: 't' }, h('div', { class: 'nm' }, h('span', { class: `gcrc ${c2}` }, l2), drvName(x)),
                                h('div', { class: 'sub mono' }, `${playQuarter(x.q)} ${x.start} · ${x.n} play${x.n === 1 ? '' : 's'} · ${x.yds} yds`))); }))),
                h('div', { class: 'gcpcol' },
                    h('div', { class: `gcsum${live ? ' live' : ''}` }, h('img', { class: 'gclogo', src: teamLogo(d.pos), alt: '' }),
                        h('div', { class: 'gcst' }, h('span', { class: 'eb' }, `${d.pos} drive · ${di + 1} of ${drives.length}`),
                            h('div', { class: 'hl', title: head }, h('span', { class: `gcrc ${live ? 'live' : rc}` }, live ? 'LIVE' : rl), head)),
                        h('div', { class: 'cells' }, cell('Plays', String(d.n)), cell('Yards', String(d.yds)), cell('Time', mmss(d.dur)), cell('Started', `${playQuarter(d.q)} ${d.start} · ${d.startYl}`))),
                    h('div', { class: 'gccolh' }, h('span', null, 'Clock'), h('span', null, 'Down · spot'), h('span', null, 'Play · fantasy points'), h('span', { class: 'r' }, 'Gain')),
                    ...shown.map(playRow),
                    all.length > shown.length ? h('div', { class: 'gcmore' }, `${all.length - shown.length} earlier play${all.length - shown.length === 1 ? '' : 's'} in this drive · `,
                        h('button', { class: 'lnk', type: 'button', 'data-act': 'gc-more', onclick: () => { S.ui.gcMore = true; render(); } }, 'show')) : null)));
    }
    // ── the players, a column a team and a group a position. Points draws each one's projection on his bar (the
    // fill scored, the outline his projection for the game, the tick that projection's share for the game played);
    // Box score is the stat columns, every position on one grid so the columns line up group to group. Whose he is
    // shows as that fantasy team's picture (the user, 2026-10-20).
    const plMode = S.ui.gcPl === 'box' ? 'box' : 'pts';
    const skill = box ? box.list.filter(r => GC_POS.has(ppos(String(r.player_id)))).map(r => { const pid = String(r.player_id), st = r.stats || {}; return { pid, st, pts: scoreStats(st) || 0, team: r.team || (P(pid) || {}).team, pos: ppos(pid) }; })
        .filter(r => r.pts || r.st.pass_att || r.st.rush_att || r.st.rec_tgt || r.st.fga || r.st.xpa) : [];
    const playedOf = (pid) => g.over ? 1 : started2 ? Math.max(0, Math.min(1, 1 - gameFracLeft(pid))) : 0;
    const barMax = Math.max(12, ...skill.map(r => Math.max(r.pts, projOf(r.pid, S.week) || 0)));
    const ownCell = (pid, compact) => { const o = gcOwner(pid, oppR);
        if (o.cls === 'fa') return h('span', { class: 'gcown fa', title: 'Available in your league' }, h('span', { class: 'fa2' }, 'FA'),
            compact ? null : h('button', { class: 'btn xs warn', type: 'button', onclick: (ev) => { ev.stopPropagation(); openComposer(pid, onWaiversNow(pid)); } }, onWaiversNow(pid) ? '+ Claim' : '+ Add'));
        return h('span', { class: `gcown ${o.cls}`, title: `${teamName(o.R)}${o.cls === 'me' ? ' (yours)' : o.cls === 'opp' ? ' (your opponent this week)' : ''}` }, avatarEl(o.R, 'xs')); };
    const W = (v) => `${Math.min(100, Math.max(0, v) / barMax * 100)}%`;
    const ptsRow = (r) => { const pj = projOf(r.pid, S.week), pace = pj != null ? pj * playedOf(r.pid) : null;
        return h('div', { class: 'gcpl', 'data-pid': r.pid, ...tap(() => { S.ui.sel = r.pid; render(); }) },
            h('img', { class: 'gcface', src: headshot(r.pid), alt: '', onerror: hideBroken }),
            h('div', { class: 'n' }, h('b', null, pname(r.pid)), h('small', { class: 'mono' }, ...(gameStatAtoms(r.pid, r.st) || []).flatMap((a, i) => [i ? ' · ' : null, h('span', null, a)]))),
            ownCell(r.pid),
            h('div', { class: 'gcpv', title: pj != null ? `${fmt1(r.pts)} scored · ${fmt1(pj)} projected for the game · ${fmt1(pace)} by now` : `${fmt1(r.pts)} scored · no projection` },
                h('span', { class: 'gcpbar' }, pj != null ? h('i', { class: 'pj', style: `width:${W(pj)}` }) : null, h('i', { class: 'ac', style: `width:${W(r.pts)}` }), pace != null ? h('i', { class: 'pc', style: `left:${W(pace)}` }) : null),
                h('span', { class: 'nums mono' }, h('b', null, fmtS(r.pts)), pj != null ? ` / ${fmt1(pj)}` : '')));
    };
    const BOXC = { QB: [['C/ATT', 'catt'], ['PASS YD', 'passYd'], ['TD-INT', 'tdint'], ['CAR', 'car'], ['RUSH YD', 'rushYd']], RB: [['CAR', 'car'], ['RUSH YD', 'rushYd'], ['REC/TGT', 'rec'], ['REC YD', 'recYd'], ['TD', 'td']],
        WR: [['REC/TGT', 'rec'], ['REC YD', 'recYd'], ['TD', 'td']], TE: [['REC/TGT', 'rec'], ['REC YD', 'recYd'], ['TD', 'td']], K: [['FG', 'fg'], ['XP', 'xp']] };
    const bv = { catt: s => s.pass_att ? `${s.pass_cmp || 0}/${s.pass_att}` : null, passYd: s => s.pass_att ? (s.pass_yd || 0) : null, tdint: s => s.pass_att ? `${s.pass_td || 0}-${s.pass_int || 0}` : null,
        car: s => s.rush_att || null, rushYd: s => s.rush_att ? (s.rush_yd || 0) : null, rec: s => (s.rec_tgt || s.rec) ? `${s.rec || 0}/${Math.max(s.rec_tgt || 0, s.rec || 0)}` : null, recYd: s => (s.rec_tgt || s.rec) ? (s.rec_yd || 0) : null,
        td: s => ((s.rush_td || 0) + (s.rec_td || 0)) || null, fg: s => s.fga ? `${s.fgm || 0}/${s.fga}` : null, xp: s => s.xpa ? `${s.xpm || 0}/${s.xpa}` : null };
    const bnum = (v) => v == null ? -1 : Number(String(v).split(/[/-]/)[0]) || 0;
    // two players with one short name (B. Robinson and B. Robinson) take as much of the first name as tells them apart
    const SLOTS = 5, byShort = {}; for (const r of skill) (byShort[shortName(r.pid)] = byShort[shortName(r.pid)] || []).push(r.pid);
    const boxName = (pid) => { const same = byShort[shortName(pid)] || []; if (same.length < 2) return shortName(pid);
        const nm = (x) => P(x) || {}, f = nm(pid).first_name || '';
        for (let k = 2; k <= f.length; k++) if (same.every(o => o === pid || (nm(o).first_name || '').slice(0, k) !== f.slice(0, k))) return `${f.slice(0, k)}. ${nm(pid).last_name || ''}`;
        return pname(pid); };
    // a header sorts its own position, both teams' columns at once
    const boxGroup = (ps, grp) => { const cols = BOXC[ps], pad = SLOTS - cols.length, srt = S.ui.gcSort && S.ui.gcSort.ps === ps ? S.ui.gcSort : null;
        const rows = srt ? grp.slice().sort((a, b) => ((srt.k === 'pts' ? b.pts - a.pts : bnum(bv[srt.k](b.st)) - bnum(bv[srt.k](a.st)))) * srt.dir) : grp;
        const th = (t, k2) => h('th', { class: `r srt ${srt && srt.k === k2 ? 'on' : ''}`, title: `Sort by ${t}`, 'aria-sort': srt && srt.k === k2 ? (srt.dir > 0 ? 'descending' : 'ascending') : null,
            ...tap(() => { S.ui.gcSort = srt && srt.k === k2 ? { ps, k: k2, dir: -srt.dir } : { ps, k: k2, dir: 1 }; render(); }, `gcsort:${ps}:${k2}`) }, t);
        return h('table', { class: 'gcbx' }, h('colgroup', null, h('col'), h('col', { style: 'width:26px' }), ...Array.from({ length: SLOTS }, () => h('col', { style: 'width:54px' })), h('col', { style: 'width:54px' })),
            h('thead', null, h('tr', null, h('th', null, h('span', { class: `pos txt ${ps}` }, posLabel(ps))), h('th'), ...Array.from({ length: pad }, () => h('th')), ...cols.map(([t, k2]) => th(t, k2)), th('FPTS', 'pts'))),
            h('tbody', null, ...rows.map(r => h('tr', { 'data-pid': r.pid, ...tap(() => { S.ui.sel = r.pid; render(); }) },
                h('td', null, h('div', { class: 'bn' }, h('img', { class: 'gcface xs', src: headshot(r.pid), alt: '', onerror: hideBroken }), h('b', { title: pname(r.pid) }, boxName(r.pid)))),
                h('td', { class: 'owc' }, ownCell(r.pid, true)), ...Array.from({ length: pad }, () => h('td')),
                ...cols.map(([, k2]) => { const v = bv[k2](r.st); return h('td', { class: `r mono ${v == null ? 'z' : ''}` }, v == null ? '—' : String(v)); }),
                h('td', { class: 'r mono fpt' }, fmtS(r.pts))))));
    };
    const ORDER = ['QB', 'RB', 'WR', 'TE', 'K'];
    const teamCol = (tm) => { const rows = skill.filter(r => r.team === tm);
        return h('div', { class: 'gctc', 'data-team': tm }, h('div', { class: 'gctch' }, h('img', { class: 'gclogo', src: teamLogo(tm), alt: '' }), h('b', null, teamNick(tm)), h('span', { class: 'shm' }, rows.length ? `${rows.length} player${rows.length === 1 ? '' : 's'} with a stat` : '')),
            ...(rows.length ? ORDER.flatMap(ps => { const grp = rows.filter(r => r.pos === ps).sort((a, b) => b.pts - a.pts); if (!grp.length) return [];
                return plMode === 'box' ? [boxGroup(ps, grp)] : [h('div', { class: 'gcpg' }, h('span', { class: `pos txt ${ps}` }, posLabel(ps))), ...grp.map(ptsRow)]; })
                : [h('div', { class: 'gcnone' }, started2 ? 'Nobody has a stat yet.' : `It kicks off ${day(g.t)} ${kick(g.t)}.`)]));
    };
    const plBtn = (k2, t) => h('span', { class: plMode === k2 ? 'on' : '', 'data-pl': k2, ...tap(() => { S.ui.gcPl = k2; render(); }, `gcpl:${k2}`), role: 'tab', 'aria-selected': String(plMode === k2) }, t);
    const players = h('div', { class: 'card gcplayers' },
        h('div', { class: 'gcplh' }, h('h3', null, 'Players'), h('div', { class: 'tabs gcplsw', role: 'tablist', 'aria-label': 'Players view' }, plBtn('pts', 'Points'), plBtn('box', 'Box score')),
            h('span', { class: 'gclegend' },
                plMode === 'pts' ? [h('span', null, h('i', { class: 'lk ac' }), 'scored'), h('span', null, h('i', { class: 'lk pj' }), 'projected for the game'), h('span', null, h('i', { class: 'lk pc' }), started2 && !g.over ? 'projected by now' : 'where the projection ends')]
                    : h('span', null, 'each position its own columns · a header sorts'),
                S.myRoster ? h('span', { class: 'gcown me' }, avatarEl(S.myRoster, 'xs'), 'yours') : null, oppR ? h('span', { class: 'gcown opp' }, avatarEl(oppR, 'xs'), 'your opponent') : null,
                h('span', null, 'any other picture: the team that has him · FA: free agent'))),
        h('div', { class: 'gcteams' }, teamCol(g.away), teamCol(g.home)));
    // ── scoring summary and team stats
    const scoring = plays.map((p, i) => ({ p, i })).filter(({ p }) => p.metadata.is_scoring_play && !/extra_point|two_point/.test(p.metadata.play_type));
    const scoringCard = h('div', { class: 'card gcside-card' }, h('h3', null, 'Scoring', h('small', { class: 'mono' }, `${scoring.length} score${scoring.length === 1 ? '' : 's'}`)),
        ...(scoring.length ? scoring.map(({ p, i }) => {
            const m = p.metadata, pat = /field_goal/.test(m.play_type) ? null : plays.slice(i + 1, i + 4).find(x => /extra_point|two_point/.test(x.metadata.play_type));
            const fin = (pat || p).metadata, fx = gcPlayFx(p).concat(pat ? gcPlayFx(pat) : []).filter(x => Math.abs(x.pts) >= 0.5);
            return h('div', { class: 'gcscr' }, h('img', { class: 'gclogo', src: teamLogo(m.scoring_team || m.possession), alt: '' }), h('span', { class: 'k' }, `${playQuarter(m.quarter_name)} ${/field_goal/.test(m.play_type) ? 'FG' : 'TD'}`),
                h('span', null, m.scoring_description || m.fantasy_description || m.description, pat ? h('span', { class: 'dim' }, ` · ${/good/i.test(pat.metadata.description || '') ? 'PAT good' : 'PAT'}`) : null),
                h('span', { class: 'sco mono' }, `${g.away} ${fin.away_points} · ${g.home} ${fin.home_points}`), fx.length ? h('div', { class: 'fx' }, ...fx.map(x => gcChip(x.pid, x.pts, oppR))) : null);
        }) : [h('div', { class: 'gcnone' }, 'No scores yet')]));
    const T = {}; if (box) for (const r of box.list) if (/^TEAM_/.test(r.player_id)) T[r.player_id.slice(5)] = r.stats || {};
    const ta = T[g.away], th2 = T[g.home];
    const teamCard = ta && th2 ? h('div', { class: 'card gcside-card' }, h('h3', null, 'Team stats', h('small', { class: 'mono' }, `${g.away} · ${g.home}`)),
        ...[['Total yards', s => s.off_yd || 0], ['Passing', s => s.pass_yd || 0], ['Rushing', s => s.rush_yd || 0], ['First downs', s => s.fd || 0],
            ['3rd down', s => (s.down_3_conv || 0) / (s.down_3_att || 1), s => `${s.down_3_conv || 0}/${s.down_3_att || 0}`], ['Red zone', s => (s.rz_conv || 0) / (s.rz_att || 1), s => `${s.rz_conv || 0}/${s.rz_att || 0}`],
            ['Turnovers', s => (s.pass_int || 0) + (s.fum_lost || 0)], ['Sacks taken', s => s.pass_sack || 0], ['Penalties', s => s.penalty || 0, s => `${s.penalty || 0}-${s.penalty_yd || 0}`], ['Yards / play', s => s.off_yd_per_play || 0]]
            .map(([lab, val, fmt]) => { const va = val(ta), vh = val(th2), tot = (va + vh) || 1;
                return h('div', { class: 'gctsr' }, h('span', { class: 'l mono' }, fmt ? fmt(ta) : va), h('div', null, h('div', { class: 'lab' }, lab), h('div', { class: 'bars' }, h('span', { class: 'a' }, h('i', { style: `width:${va / tot * 100}%` })), h('span', { class: 'h' }, h('i', { style: `width:${vh / tot * 100}%` })))), h('span', { class: 'r mono' }, fmt ? fmt(th2) : vh)); })) : null;
    const main = h('div', { class: 'gcmain' }, bug, meta, field, pbp, players, h('div', { class: 'gcbody2' }, scoringCard, teamCard));
    page.append(h('div', { class: 'card gcframe' }, rail, main));
    return page;
}
function pageMatchup() {
    const ms = S.matchups[S.week] || [];
    let R = S.ui.matchupRoster ? rosterById(S.ui.matchupRoster) : S.myRoster;
    if (!R && S.rosters.length) R = S.rosters[0];
    const a = R ? ms.find(m => m.roster_id === R.roster_id) : null;
    const b = a ? ms.find(m => m.matchup_id === a.matchup_id && m.roster_id !== a.roster_id) : null;
    const A = R, B = b ? rosterById(b.roster_id) : null;
    // One switch, always in the same place, and the right-hand option is not a
    // generic label — it names the game you last looked at, so the control says
    // where it will take you before you press it. Six days a week you want your
    // own team, so 'one' is the landing view; on Sunday afternoon the preference
    // flips, and the choice sticks for the session.
    const all = S.ui.muView === 'all', nfl = S.ui.muView === 'nfl';
    const focusName = A ? (B ? `${teamName(A)} v ${teamName(B)}` : teamName(A)) : 'This matchup';
    // The right-hand chip is a dropdown, not a shortcut back to one game: from
    // the six-game view it opens ANY of them, and from a single game it walks to
    // the next without going back first. It doubles as a scoreboard — each row
    // carries that game's score and state — so you can see which one is worth
    // opening before you open it.
    const pickRow = (g2) => {
        const st2 = g2.st, on = !!(a && g2.m.matchup_id === a.matchup_id);
        return h('div', { class: `mp ${on ? 'on' : ''}`.trim(), onclick: (e) => { e.stopPropagation(); S.ui.muPick = false; S.ui.matchupRoster = g2.A.roster_id; S.ui.muView = 'one'; render(); } },
            h('span', { class: 'pair' }, avatarEl(g2.A, 'xs'), g2.B ? avatarEl(g2.B, 'xs') : null),
            h('span', { class: 'mpn' }, teamName(g2.A), h('b', null, ' v '), g2.B ? teamName(g2.B) : 'Bye',
                g2.mine ? h('span', { class: 'mpyou' }, 'YOURS') : null),
            h('span', { class: 'mpsc mono' }, `${fmtS(st2.vX)}–${fmtS(st2.vY)}`, h('small', { class: st2.state === 'live' ? 'live' : '' }, muTag(st2))));
    };
    const pickMenu = () => {
        const ms2 = S.matchups[S.week] || [];
        const rows = muPairs().map((m2) => {
            const A2 = rosterById(m2.roster_id); if (!A2) return null;
            const o2 = ms2.find(z => z.matchup_id === m2.matchup_id && z.roster_id !== m2.roster_id) || null;
            const B2 = o2 ? rosterById(o2.roster_id) : null;
            return pickRow({ m: m2, A: A2, B: B2, st: muState(A2, m2, B2, o2),
                mine: !!(S.myRoster && (A2.roster_id === S.myRoster.roster_id || (B2 && B2.roster_id === S.myRoster.roster_id))) });
        }).filter(Boolean);
        return h('div', { class: 'mupick', onclick: (e) => e.stopPropagation() },
            h('div', { class: 'mphd' }, 'GO TO A MATCHUP'), ...rows);
    };
    // ── the Scoreboard's switch row ──
    // Two tabs, because the real split is fantasy versus the NFL: Matchups and
    // NFL games. Inside Matchups the six-game Wall is the overview and a game is
    // a drill-down, with a breadcrumb back ("All matchups / A v B ▾", the name
    // opening the picker) and ‹ › through the six in Wall order. My matchup sits
    // at the right of the row in every state, carrying your score and state, lit
    // when you are on your game — one click home from anywhere, NFL games
    // included. The Matchups tab returns to whichever of its two views you last
    // had. The old row was three look-alike pills: a scope, a dropdown and a
    // different kind of content, the middle one naming whatever game you last
    // opened even while the league view was on screen.
    const pairs = muPairs();
    const view = nfl ? 'nfl' : all ? 'all' : 'one';
    if (view !== 'nfl') S.ui.muLast = view;
    const tab = (on, label, go, title) => h('span', { class: on ? 'on' : '', title: title || null, onclick: (e) => { e.stopPropagation(); S.ui.muPick = false; go(); render(); } }, label);
    const tabs = h('div', { class: 'mtabs', role: 'tablist' },
        tab(!nfl, 'Matchups', () => { S.ui.muView = S.ui.muLast === 'all' ? 'all' : 'one'; }, 'Your league’s matchups'),
        tab(nfl, 'NFL games', () => { S.ui.muView = 'nfl'; }, 'The real NFL games, with the fantasy read on every play'));
    let crumb = null;   // no ‹ 1 / 6 › stepper: the breadcrumb's picker and the Wall already reach every game
    if (view === 'all') crumb = h('span', { class: 'mcrumb' }, h('b', null, `All ${pairs.length || ''} matchups`.replace('  ', ' ')));
    else if (view === 'one') {
        crumb = h('span', { class: 'mcrumb' },
            h('a', { onclick: (e) => { e.stopPropagation(); S.ui.muPick = false; S.ui.muView = 'all'; render(); } }, 'All matchups'),
            h('span', { class: 'sep' }, '/'),
            h('span', { class: `crumbpick${S.ui.muPick ? ' open' : ''}`, title: `${focusName} — pick a matchup`, onclick: (e) => { e.stopPropagation(); S.ui.muPick = !S.ui.muPick; render(); } },
                h('b', { class: 'pcap' }, focusName), caret('pcar'),
                S.ui.muPick ? pickMenu() : null));
    }
    let mineBtn = null;
    if (S.myRoster) {
        const mm = myMatchup(S.week);
        const onMine = view === 'one' && !!(a && mm && a.matchup_id === mm.mine.matchup_id);
        let scoreKids = [h('span', { class: 'mmst' }, mm ? '' : 'BYE')];
        if (mm) {
            const oppR = mm.opp ? rosterById(mm.opp.roster_id) : null;
            const st3 = muState(S.myRoster, mm.mine, oppR, mm.opp);
            scoreKids = [h('span', { class: 'mono mmsc' }, oppR ? `${fmtS(st3.vX)}–${fmtS(st3.vY)}` : fmtS(st3.vX)),
                h('span', { class: `mmst ${st3.state === 'live' ? 'live' : ''}` }, muTag(st3))];
        }
        mineBtn = h('button', { class: `mmine${onMine ? ' on' : ''}`, title: onMine ? 'Your matchup is on screen' : 'Go to your matchup',
            onclick: (e) => { e.stopPropagation(); S.ui.muPick = false; S.ui.matchupRoster = null; S.ui.muView = 'one'; render(); } },
            avatarEl(S.myRoster, 'xs'), h('span', { class: 'mmlab' }, 'My matchup'), ...scoreKids);
    }
    const swCard = h('div', { class: 'card span2 swrap mswitch' }, tabs, weekControl(), crumb, h('span', { class: 'mspace' }), mineBtn);
    const shut = () => { if (S.ui.muPick) { S.ui.muPick = false; render(); } };
    if (all) { const p2 = allSixPage(); p2.prepend(swCard); p2.addEventListener('click', shut); return p2; }
    if (nfl) { const p3 = gameCenterPage(); p3.prepend(swCard); p3.addEventListener('click', shut); return p3; }
    const page = h('div', { class: 'page matchup', onclick: shut });
    // The league's six games, the same Wall the all-six view carries — score,
    // win odds, who is left, and the last big play — folded to one bar on
    // request, and the choice sticks. A cell opens that game.
    // Folded by default, so your game is on the first screen; the six games stay
    // one row of chips above it, and opening the Wall is remembered.
    if (S.ui.muWall === undefined) { try { S.ui.muWall = localStorage.getItem('badgerMuWall') === 'open'; } catch (e) { S.ui.muWall = false; } }
    const wallOpen = S.ui.muWall, flipWall = (e) => { e.stopPropagation(); S.ui.muWall = !S.ui.muWall; try { localStorage.setItem('badgerMuWall', S.ui.muWall ? 'open' : 'closed'); } catch (e2) { /* this visit only */ } render(); };
    const games = sixGames();
    const viewId = a ? a.matchup_id : null;
    // Folded, each game is a chip two lines high — logo, name and score per team,
    // the leader in white — all six on one row. Names give way first (a container
    // query drops them when a chip gets narrow), and the row scrolls rather than
    // wraps. A chip opens its game; your game is outlined teal, the one on screen white.
    const foldChip = (g2) => {
        const st2 = g2.st, pre = st2.state === 'proj';
        const lead = (x, y) => !pre && x > y;
        const lineOf = (R, v, w) => h('span', { class: 'fcl' }, avatarEl(R, 'xs'), h('span', { class: `fcn${w ? ' w' : ''}` }, R ? teamName(R) : 'Bye'), h('span', { class: `fcs mono${w ? ' w' : ''}` }, fmtS(v)));
        return h('span', { class: `fchip${g2.mine ? ' me' : ''}${viewId != null && g2.m.matchup_id === viewId ? ' view' : ''}`,
            title: `${teamName(g2.A)} v ${g2.B ? teamName(g2.B) : 'Bye'} \u2014 ${muTag(st2)} \u2014 open this matchup`,
            onclick: (e) => { e.stopPropagation(); openGame(g2); } },
            pre ? null : h('i', { class: `fcdot${st2.state === 'live' ? ' live' : ''}` }),
            lineOf(g2.A, st2.vX, lead(st2.vX, st2.vY)), g2.B ? lineOf(g2.B, st2.vY, lead(st2.vY, st2.vX)) : null);
    };
    const bar = h('div', { class: `wallbar${wallOpen ? '' : ' fold'}`, onclick: flipWall, title: wallOpen ? 'Fold the league scoreboard' : 'Show the league scoreboard' },
        foldCaret(wallOpen, 'chev'), h('b', null, wallOpen ? 'League scoreboard' : 'League'),
        wallOpen ? null : h('span', { class: 'wallchips', onclick: (e) => e.stopPropagation() }, ...games.map(foldChip)));
    page.append(swCard, h('div', { class: `card span2 wallcard ${wallOpen ? '' : 'folded'}` }, bar, wallOpen ? h('div', { class: 'wall' }, ...games.map(g2 => sixCell(g2, viewId))) : null));
    if (a && B) {
        const tab = muTab(); page.classList.add('mtabbed'); page.append(muRail(games, viewId), muTabBar(tab));
        if (tab === 'bd') { page.append(...breakdownCards(A, a, B, b)); return page; }
    }
    page.append(matchupHeader(R, false));
    if (a && B) { page.append(muMirror(A, a, B, b)); page.append(muState(A, a, B, b).state === 'proj' ? edgeCard(A, a, B, b) : playLog(A, a, B, b)); }
    else if (a) { page.append(lineupCard(A, a, true)); page.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Bye week — no opponent.'))); }
    else page.append(h('div', { class: 'card span2' }, h('div', { class: 'empty' }, ms.length ? 'Pick a matchup above.' : 'No matchups for this week.')));
    return page;
}
// ── the matchup's Breakdown tab ──────────────────────────────────────────────
// The single matchup page has two tabs (the user, 2026-10-25, picked B): Live, the page it always was with two
// cards gaining a view each, and Breakdown, the second-level read. Rows have a set height and a long list
// scrolls inside its card ("make the tiles less freakishly tall and use scrolls within the widgets"), so a row
// ends level without a tile stretched to its tallest neighbour. The open tab is a per-viewer preference.
function muTab() { if (S.ui.muTab) return S.ui.muTab; let v = 'live'; try { v = localStorage.getItem('badgerMuTab') === 'bd' ? 'bd' : 'live'; } catch (e) {} return (S.ui.muTab = v); }
function setMuTab(v) { S.ui.muTab = v; try { localStorage.setItem('badgerMuTab', v); } catch (e) {} render(); }
// The league's games in a rail on the left, as NFL games has them (the user, 2026-10-25), wherever the page has two
// columns: with team names from 1600px; narrower, slim (each team its avatar and score) with the play log's Score
// now column dropped to pay for it, which at 1280 leaves Head to head's names as the League strip did. Stacked,
// CSS hides the rail and the strip stays. All matchups at the top, your game first, the one on screen marked.
function muRail(games, viewId) {
    const cell = (g) => {
        const st = g.st, pre = st.state === 'proj', on = viewId != null && g.m.matchup_id === viewId, go = () => openGame(g);
        const line = (R, v, lead) => h('div', { class: `rmt${lead ? ' lead' : ''}`, title: R ? `${teamName(R)} ${fmtS(v)}` : 'Bye' },
            R ? avatarEl(R, 'xs') : h('span'), h('span', { class: 'nm' }, R ? teamName(R) : 'Bye'), h('span', { class: 'sc mono' }, R ? fmtS(v) : ''));
        const pct = st.state === 'fin' || !g.B ? '' : `${st.wX}% – ${100 - st.wX}%`;
        return h('div', { class: `rmg${on ? ' on' : ''}`, role: 'button', tabindex: '0', 'aria-current': on ? 'true' : null, 'data-focus': `murail:${g.m.matchup_id}`,
            title: `${g.A ? teamName(g.A) : ''} ${fmtS(st.vX)} v ${g.B ? teamName(g.B) : 'Bye'} ${g.B ? fmtS(st.vY) : ''}${pct ? ` · ${pct}` : ''} · ${on ? 'on screen' : 'open this matchup'}`,
            onclick: (e) => { e.stopPropagation(); go(); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } } },
            line(g.A, st.vX, !pre && st.vX >= st.vY), line(g.B, st.vY, !pre && st.vY > st.vX),
            h('div', { class: 'rms mono' }, st.state === 'live' ? h('span', { class: 'lv' }, '● LIVE') : muTag(st), pct ? h('span', { class: 'rpc' }, ` · ${pct}`) : null));
    };
    const mine = games.filter((g) => g.mine), rest = games.filter((g) => !g.mine);
    return h('div', { class: 'card murail' },
        h('button', { class: 'ram', type: 'button', onclick: (e) => { e.stopPropagation(); S.ui.muPick = false; S.ui.muView = 'all'; render(); } }, 'All matchups', h('span', null, `${games.length} games`)),
        mine.length ? h('h4', null, 'Your matchup') : null, ...mine.map(cell),
        rest.length ? h('h4', null, 'The league') : null, ...rest.map(cell));
}
function muTabBar(on) {
    return h('div', { class: 'span2 mutabs' }, h('div', { class: 'ptabs', role: 'tablist' },
        ...[['live', 'Live'], ['bd', 'Breakdown']].map(([k, t]) => h('button', { class: k === on ? 'on' : '', type: 'button', role: 'tab', 'aria-selected': String(k === on), 'data-focus': `mutab:${k}`,
            onclick: (e) => { e.stopPropagation(); setMuTab(k); } }, t))));
}
function breakdownCards(A, a, B, b) {
    // a number is the row's height; 'fit' sizes the row to its right-hand stack and lets the left card's list scroll
    const row = (h0, ...cards) => h('div', { class: `bdrow${h0 === 'fit' ? ' fit' : h0 ? ' set' : ''}`, style: typeof h0 === 'number' && h0 ? `height:${h0}px` : null }, ...cards);
    return [h('div', { class: 'span2 bdgrid' },
        row(470, bdOverUnder(A, a, B, b), bdWinAdded(A, a, B, b)),
        row(0, bdSources(A, a, B, b), bdBigPlays(A, a, B, b)),
        row('fit', bdLeagueWeek(A, B), h('div', { class: 'bdstack' }, bdBench(A, a, B, b), bdMeetings(A, B))))];
}
// 4 · Over / under: the all-games card itself, cut to these two lineups
function bdOverUnder(A, a, B, b) {
    const ids = new Set([A.roster_id, B.roster_id]);
    return overUnderCard(leagueStarters().filter((x) => x.started && ids.has(x.R.roster_id)), { sub: 'against his projection so far, in this game only', keep: 'muou' });
}
// 5 · Win probability added: each play's swing in this game's odds, shared among the starters on it by their
// points, and counted for the player's own side
function bdWinAdded(A, a, B, b) {
    const L = buildLedger(A, a, B, b), tot = {};
    for (const e of (L ? L.events : [])) {
        if (e.kind === 'clock' || !e.who || !e.who.length) continue;
        const abs = e.who.reduce((t, w) => t + Math.abs(w.dp || 0), 0); if (!abs) continue;
        for (const w of e.who) { const share = e.dw * Math.abs(w.dp || 0) / abs; tot[w.pid] = (tot[w.pid] || { v: 0, side: w.side }); tot[w.pid].v += w.side === 'b' ? -share : share; }
    }
    const rows = Object.entries(tot).map(([pid, x]) => ({ pid, v: x.v * 100, side: x.side })).filter((x) => Math.abs(x.v) >= 0.05).sort((p, q) => q.v - p.v);
    const head = s6Head('Win probability added', 'who has moved this game’s odds most for his own side');
    if (!rows.length) return h('div', { class: 'card s6feed bdcard' }, head, h('div', { class: 'empty' }, L ? 'No play has moved the odds yet.' : 'Reading this week’s plays from Sleeper…'));
    const max = Math.max(...rows.map((x) => Math.abs(x.v)));
    const R0 = { a: A, b: B };
    return h('div', { class: 'card s6feed bdcard' }, head,
        h('div', { class: 's6list', 'data-keep': 'muwpa' }, ...rows.map((x) => h('div', { class: 'wparow', title: `${pname(x.pid)}: ${x.v > 0 ? 'added' : 'cost'} ${fmt1(Math.abs(x.v))} points of ${teamName(R0[x.side])}’s chance to win`, onclick: () => { S.ui.sel = x.pid; render(); } },
            faceEl(x.pid, R0[x.side]),
            s6Lab([h('b', null, pname(x.pid))], [h('span', { class: `s6l2 ${x.side}` }, teamName(R0[x.side]))]),
            h('span', { class: 'wpabar' }, h('i', { class: `${x.side}${x.v < 0 ? ' neg' : ''}`, style: `width:${(Math.abs(x.v) / max * 100).toFixed(1)}%` })),
            h('span', { class: `wpav mono ${x.v > 0 ? 'up' : 'dn'}` }, `${x.v > 0 ? '▲ +' : '▼ −'}${fmt1(Math.abs(x.v))}%`)))),
        h('div', { class: 'cap' }, 'Each play’s swing in win odds, shared among the players on it by their points.'));
}
// 2 · Where the points came from, in this league's scoring: each starter's stats priced by category, a
// defence's points as D/ST, and whatever a stat line does not explain (bonuses, rounding) as Other
const BD_SRC = [['Yardage', 'yd'], ['Touchdowns', 'td'], ['Receptions', 'rec'], ['Kicking', 'k'], ['D/ST', 'dst'], ['Turnovers', 'to'], ['Other', 'oth']];
const bdCat = (k) => /^(pass|rush|rec)_yd$/.test(k) ? 'Yardage' : /^(pass|rush|rec)_(td|2pt)/.test(k) ? 'Touchdowns' : (k === 'rec' || /^bonus_rec/.test(k)) ? 'Receptions'
    : /^(pass_int|fum_lost|fum)$/.test(k) ? 'Turnovers' : /^(fgm|fgmiss|xpm|xpmiss)/.test(k) ? 'Kicking' : 'Other';
function bdSourcesOf(R, m) {
    const out = {}, sc = (S.league && S.league.scoring_settings) || {}, add = (c, v) => { out[c] = (out[c] || 0) + v; };
    for (const pid of muStarters(R, m)) {
        if (!pid || pid === '0') continue;
        const pts = ((m && m.players_points) || {})[pid] || 0;
        if (ppos(pid) === 'DEF') { add('D/ST', pts); continue; }
        const st = ((S.stats[S.week] || {})[pid] || {}).stats || {}; let got = 0;
        for (const k in st) if (sc[k] != null && typeof st[k] === 'number' && st[k]) { const v = st[k] * sc[k]; add(bdCat(k), v); got += v; }
        if (Math.abs(pts - got) > 0.05) add('Other', pts - got);
    }
    return out;
}
// A stacked bar in seven category colours read badly (the user, 2026-10-25: greys and pinks too alike). Away from
// teal and blue (the two sides) and green and red (gain and loss), no set of hues stays apart, so there are none: a row per
// category, your side's bar to the left and theirs to the right in the sides' own colours, the numbers at the ends.
function bdSources(A, a, B, b) {
    const sa = bdSourcesOf(A, a), sb = bdSourcesOf(B, b);
    const cats = BD_SRC.filter(([c2]) => Math.abs(sa[c2] || 0) >= 0.05 || Math.abs(sb[c2] || 0) >= 0.05);
    const max = Math.max(1, ...cats.flatMap(([c2]) => [sa[c2] || 0, sb[c2] || 0]));
    const W = (v) => `${(Math.max(0, v) / max * 100).toFixed(1)}%`, tot = (sx) => cats.reduce((t, [c2]) => t + (sx[c2] || 0), 0);
    const v = (x, lead, r) => h('span', { class: `srcv mono${lead ? ' lead' : ''}${r ? ' r' : ''}` }, `${x < 0 ? '−' : ''}${fmt1(Math.abs(x))}`);
    return h('div', { class: 'card bdcard' }, s6Head('Where the points came from', 'did each side win on volume, or on touchdowns?'),
        h('div', { class: 'srchead' }, h('span', { class: 'a' }, teamName(A)), h('span', { class: 'b' }, teamName(B))),
        ...cats.map(([c2]) => { const va = sa[c2] || 0, vb = sb[c2] || 0;
            return h('div', { class: 'srcrow', title: `${c2}: ${teamName(A)} ${fmt1(va)}, ${teamName(B)} ${fmt1(vb)}` }, v(va, va > vb),
                h('span', { class: 'srcb l' }, h('i', { style: `width:${W(va)}` })), h('span', { class: 'srcc' }, c2),
                h('span', { class: 'srcb r' }, h('i', { style: `width:${W(vb)}` })), v(vb, vb > va, true)); }),
        h('div', { class: 'srcrow tot' }, v(tot(sa), tot(sa) > tot(sb)), h('span'), h('span', { class: 'srcc' }, 'Total'), h('span'), v(tot(sb), tot(sb) > tot(sa), true)),
        h('div', { class: 'cap' }, 'In this league’s scoring. A negative, such as an interception, shows its number with no bar.'));
}
// 14 · Big plays and the red zone, from the week's plays: starters only
function bdBigPlays(A, a, B, b) {
    const sets = { a: new Set(muStarters(A, a)), b: new Set(muStarters(B, b)) }, cnt = { a: { big: 0, pass: 0, rz: 0 }, b: { big: 0, pass: 0, rz: 0 } }, tds = { a: [], b: [] };
    const rec = S.plays[S.week];
    for (const p of (rec && rec.list) || []) {
        const md = p.metadata || {};
        for (const ps of playStatsOf(p)) {
            const pid = String(ps.player_id), st = ps.stats || {}, k = sets.a.has(pid) ? 'a' : sets.b.has(pid) ? 'b' : null;
            if (!k) continue;
            if (Math.max(st.rush_yd || 0, st.rec_yd || 0) >= 20) cnt[k].big++;
            if ((st.pass_yd || 0) >= 20 && ppos(pid) === 'QB') cnt[k].pass++;
            if (md.yards_to_end_zone != null && md.yards_to_end_zone <= 20 && (st.rush_att || st.rec_tgt)) cnt[k].rz++;
            if (st.rush_td) tds[k].push([pid, `${md.yards_gained || 0}-yard TD run`]);
            if (st.rec_td) tds[k].push([pid, `${md.yards_gained || 0}-yard TD catch`]);
        }
    }
    const side = (R, k) => h('div', { class: 'bpside' }, h('div', { class: `bpnm ${k}` }, teamName(R)),
        h('div', { class: 'bptiles' }, ...[['big', '20+ yard plays'], ['pass', '20+ yard passes'], ['rz', 'red-zone touches']].map(([f, t]) => h('div', { class: 'bptile' }, h('b', { class: 'mono' }, String(cnt[k][f])), h('span', null, t)))),
        tds[k].length ? h('div', { class: 'bptds' }, ...tds[k].map(([pid, t]) => h('div', { class: 'bptd', onclick: () => { S.ui.sel = pid; render(); } }, faceEl(pid, R), h('b', null, (P(pid) || {}).last_name || pname(pid)), h('span', null, t))))
            : h('div', { class: 'bptd none' }, 'No touchdowns yet.'));
    return h('div', { class: 'card bdcard' }, s6Head('Big plays and the red zone', 'how did the points happen?'),
        h('div', { class: 'bpsides' }, side(A, 'a'), side(B, 'b')),
        h('div', { class: 'cap' }, rec ? 'Starters only, from every play Sleeper records.' : 'Reading this week’s plays from Sleeper…'));
}
// 11 · This week across the league: every team's score so far, and whom each side would beat
function bdLeagueWeek(A, B) {
    const ms = (S.matchups[S.week] || []).map((m) => ({ R: rosterById(m.roster_id), v: m.points || 0 })).filter((x) => x.R).sort((p, q) => q.v - p.v);
    const beats = (R) => { const me = ms.find((x) => x.R.roster_id === R.roster_id); return me ? ms.filter((x) => x !== me && x.v < me.v).length : 0; };
    const max = Math.max(1, ...ms.map((x) => x.v)), cls = (R) => R.roster_id === A.roster_id ? 'a' : R.roster_id === B.roster_id ? 'b' : '';
    return h('div', { class: 'card s6feed bdcard' }, s6Head('This week across the league', 'would your score beat anyone else this week?'),
        h('div', { class: 'lwhead' }, h('span', { class: 'a' }, `${teamName(A)} would beat `, h('b', { class: 'mono' }, String(beats(A))), ` of ${ms.length - 1}`),
            h('span', { class: 'b' }, `${teamName(B)} `, h('b', { class: 'mono' }, String(beats(B))), ` of ${ms.length - 1}`)),
        h('div', { class: 's6list lwlist', 'data-keep': 'mulw' }, ...ms.map((x, i) => h('div', { class: `lwrow ${cls(x.R)}` },
            h('span', { class: 'lwn' }, `${i + 1}. `, teamName(x.R)), h('span', { class: 'lwbar' }, h('i', { style: `width:${(x.v / max * 100).toFixed(1)}%` })), h('span', { class: 'mono lwv' }, fmt1(x.v))))),
        h('div', { class: 'cap' }, 'Every team’s score this week so far.'));
}
// 7 · Bench points and the best possible lineup, with hindsight, from points scored so far: Sleeper's best
// legal lineup (the same exact search the standings use), and the bench players who outscored a starter
function bdBenchSide(R, m, k) {
    const pp = (m && m.players_points) || {}, starters = muStarters(R, m), slots = starterSlots();
    const bench = muBench(R, m), bpts = bench.reduce((t, pid) => t + (pp[pid] || 0), 0), best = Math.max(m.points || 0, optimalPointsFrom(m));
    const fits = (pid, sl) => { const p2 = ppos(pid); return FLEX[sl] ? FLEX[sl].includes(p2) : (sl === 'DEF' ? p2 === 'DEF' : p2 === sl); };
    const used = new Set(), swaps = [];
    for (const bp of bench.slice().sort((x, y) => (pp[y] || 0) - (pp[x] || 0))) {
        let low = -1;
        starters.forEach((sp, i) => { if (used.has(i) || !fits(bp, slots[i])) return; const v = sp && sp !== '0' ? pp[sp] || 0 : -1; if ((pp[bp] || 0) > v && (low < 0 || v < (pp[starters[low]] || 0))) low = i; });
        if (low >= 0) { used.add(low); swaps.push([bp, starters[low], (pp[bp] || 0) - (pp[starters[low]] || 0)]); }
    }
    return h('div', { class: 'bnside' }, h('div', { class: `bnnm ${k}` }, teamName(R)),
        h('div', { class: 'bnl' }, h('b', { class: 'mono' }, fmt1(bpts)), ' on the bench so far'),
        h('div', { class: 'bnl dim' }, 'Best possible lineup ', h('b', { class: 'mono' }, fmt1(best)), ` against ${fmt1(m.points || 0)} started`),
        ...swaps.map(([i2, o, d]) => h('div', { class: 'bnsw' }, faceEl(i2, R), h('span', null, h('b', null, (P(i2) || {}).last_name || pname(i2)), h('small', null, ` ${fmt1(pp[i2] || 0)}`), ' over ',
            h('b', null, o && o !== '0' ? (P(o) || {}).last_name || pname(o) : 'an empty slot'), h('small', null, ` ${fmt1(pp[o] || 0)}`)), h('span', { class: 'mono up' }, `+${fmt1(d)}`))));
}
function bdBench(A, a, B, b) {
    return h('div', { class: 'card bdcard bdscroll' }, s6Head('Bench points and the best possible lineup', 'what did each side leave on the bench?'),
        h('div', { class: 'bdbody', 'data-keep': 'mubench' }, h('div', { class: 'bngrid' }, bdBenchSide(A, a, 'a'), bdBenchSide(B, b, 'b'))),
        h('div', { class: 'cap' }, 'With hindsight, from the points scored so far.'));
}
// 12 · Head to head, all time: every regular-season meeting of these two managers in this league, this
// season's from the weeks already loaded and earlier seasons' from the previous_league_id chain, fetched
// once a season and kept (a finished season never changes)
async function loadPastMeetings() {
    if (S.pastMu || S.pastMuBusy) return; S.pastMuBusy = true;
    try {
        await Promise.all(Array.from({ length: Math.max(0, S.week - 1) }, (_, i) => i + 1).filter((w) => !S.matchups[w]).map((w) => loadMatchups(w)));
        await loadSeasonChain();
        const out = [];
        for (const c of S.chain || []) {
            let rec = await idbGet(`pastmu:${c.id}`);
            if (!rec) {
                const rs = await rest(`${API}/league/${c.id}/rosters`), weeks = {};
                for (let w = 1; w <= 18; w++) {
                    const ms = await rest(`${API}/league/${c.id}/matchups/${w}`).catch(() => null);
                    if (!ms || !ms.length || !ms.some((m) => m.points)) break;
                    weeks[w] = ms.map((m) => ({ roster_id: m.roster_id, matchup_id: m.matchup_id, points: m.points || 0 }));
                }
                rec = { season: c.season, owners: Object.fromEntries(rs.map((r) => [r.roster_id, r.owner_id])), weeks };
                await idbSet(`pastmu:${c.id}`, rec);
            }
            out.push(rec);
        }
        S.pastMu = out;
    } catch (e) { console.warn(TAG, 'past meetings:', e.message); S.pastMu = S.pastMu || []; }
    finally { S.pastMuBusy = false; render(); }
}
function bdMeetings(A, B) {
    if (!S.pastMu) loadPastMeetings();
    const oa = A.owner_id, ob = B.owner_id, list = [];
    const scan = (season, owners, weeks, live) => {
        const ra = Object.keys(owners).find((r) => owners[r] === oa), rb = Object.keys(owners).find((r) => owners[r] === ob);
        if (!ra || !rb) return;
        for (const w of Object.keys(weeks).map(Number).sort((x, y) => y - x)) {
            const x = weeks[w].find((m) => String(m.roster_id) === ra), y = weeks[w].find((m) => String(m.roster_id) === rb);
            if (x && y && x.matchup_id && x.matchup_id === y.matchup_id) list.push({ season, w, a: x.points || 0, b: y.points || 0, live: live && w === S.week && S.week >= S.curWeek });
        }
    };
    const cur = {}; for (let w = 1; w <= S.week; w++) if (S.matchups[w]) cur[w] = S.matchups[w];
    scan(S.season, Object.fromEntries(S.rosters.map((r) => [String(r.roster_id), r.owner_id])), cur, true);
    for (const p of S.pastMu || []) scan(p.season, Object.fromEntries(Object.entries(p.owners).map(([r, o]) => [String(r), o])), p.weeks, false);
    const done = list.filter((x) => !x.live), wa = done.filter((x) => x.a > x.b).length, wb = done.filter((x) => x.b > x.a).length;
    return h('div', { class: 'card bdcard bdscroll' }, s6Head('Head to head, all time', 'how have these two done against each other?'),
        h('div', { class: 'mtrec' }, h('span', { class: 'a' }, teamName(A)), h('b', { class: 'mono' }, `${wa} – ${wb}`), h('span', { class: 'b' }, teamName(B))),
        h('div', { class: 'bdbody', 'data-keep': 'mumeet' }, ...(list.length ? list.map((x) => h('div', { class: 'mtrow' }, h('span', { class: 'dim' }, `${x.season} · week ${x.w}${x.live ? ' · live' : ''}`),
            h('span', { class: `mono a${x.a > x.b ? ' w' : ''}` }, fmtS(x.a)), h('span', { class: 'dim' }, '–'), h('span', { class: `mono b${x.b > x.a ? ' w' : ''}` }, fmtS(x.b)),
            h('span', { class: 'dim' }, x.live ? '' : x.a === x.b ? 'tied' : `${x.a > x.b ? 'won' : 'lost'} by ${fmtS(Math.abs(x.a - x.b))}`)))
            : [h('div', { class: 'empty' }, S.pastMuBusy ? 'Reading earlier seasons from Sleeper…' : 'These two have not met in a regular-season game in this league.')])),
        h('div', { class: 'cap' }, 'Regular-season meetings between these two managers in this league, newest first.'));
}
// Before kickoff, in the play log's place: where each side is projected ahead,
// slot by slot, with the total. One scale for every bar — half the track is the
// larger of the total gap and the biggest single slot — so the total fills its
// side and each slot shows its share of it.
function edgeCard(A, a, B, b) {
    const slots = starterSlots(), sa = muStarters(A, a), sb = muStarters(B, b);
    const pj = (pid) => (!pid || pid === '0') ? 0 : (projOf(pid, S.week) || 0);
    const rows = slots.map((sl, i) => ({ sl, i, d: pj(sa[i]) - pj(sb[i]), hole: !sa[i] || sa[i] === '0' || !sb[i] || sb[i] === '0' }));
    const totA = sa.reduce((t, pid) => t + pj(pid), 0), totB = sb.reduce((t, pid) => t + pj(pid), 0), tot = totA - totB;
    const half = Math.max(Math.abs(tot), ...rows.map(r => Math.abs(r.d)), 0.01);
    const nA = teamName(A), nB = teamName(B);
    const who = (pid) => (pid && pid !== '0') ? pname(pid) : 'empty';
    const line = (label, d, cls, title) => {
        const zero = Math.abs(d) < 0.05, w = Math.min(50, 50 * Math.abs(d) / half);
        return h('div', { class: `edgerow${cls ? ' ' + cls : ''}`, title },
            h('span', { class: `ev mono ${zero ? 'dim' : d > 0 ? 'teal' : 'blue'}` }, zero ? '0.0' : `${d > 0 ? '+' : '\u2212'}${fmt1(Math.abs(d))}`),
            h('span', { class: 'etrack' }, zero ? null : h('i', { class: d > 0 ? 'a' : 'b', style: `width:${w.toFixed(1)}%` })),
            h('span', { class: 'esl mono' }, label));
    };
    const big = rows.slice().sort((x, y) => Math.abs(y.d) - Math.abs(x.d))[0];
    const bigNote = big && Math.abs(big.d) >= 0.05 ? ` The biggest gap is ${slotLabel(big.sl)}${big.hole ? ', an empty slot' : ''}: ${fmt1(Math.abs(big.d))}.` : '';
    return h('div', { class: 'card plcard edgecard' },
        h('div', { class: 'card-h' }, h('h3', null, 'Slot-by-slot edge'), h('span', { class: 'dim', style: 'font-size:12px' }, 'projected, before kickoff')),
        h('div', { class: 'edgelist' },
            ...rows.map(r => line(slotLabel(r.sl), r.d, r.hole ? 'hole' : '', `${slotLabel(r.sl)}: ${who(sa[r.i])} ${fmt1(pj(sa[r.i]))} v ${who(sb[r.i])} ${fmt1(pj(sb[r.i]))}`)),
            line('Total', tot, 'total', `${nA} ${fmtS(totA)} v ${nB} ${fmtS(totB)}`)),
        h('div', { class: 'cap' }, `Teal left: ${nA}${/s$/i.test(nA) ? '\u2019' : '\u2019s'} edge. Blue right: ${nB}${/s$/i.test(nB) ? '\u2019' : '\u2019s'}. Projected ${fmtS(totA)} to ${fmtS(totB)}: ${Math.abs(tot) < 0.05 ? 'level' : `${tot > 0 ? nA : nB} by ${fmt1(Math.abs(tot))}`}.${bigNote}`));
}
function lineupCard(R, m, mine) {
    const slots = starterSlots(); const live = S.week <= S.curWeek && ((m.points || 0) > 0 || S.week < S.curWeek);
    const tbl = h('table', null, h('tr', null, h('th', null, 'Slot'), h('th', null, 'Player'), h('th', { class: 'r' }, 'Pts'), h('th', { class: 'r' }, 'Proj'), h('th', null, 'Game')));
    let benchPts = 0, benchProj = 0;
    slots.forEach((s, i) => {
        const pid = (m.starters || R.starters || [])[i]; const empty = !pid || pid === '0';
        const pts = empty ? null : ((m.players_points || {})[pid] ?? (m.starters_points || [])[i]);
        const g = empty ? null : gameOf(pid, S.week);
        tbl.append(h('tr', { class: !empty && weakSlot(R, S.week) === (FLEX[s] ? 'FLEX' : s) && !mine ? '' : '' }, h('td', null, slotChip(s, null, empty ? [] : [pid])),
            h('td', null, empty ? h('span', { class: 'dim' }, 'Empty') : playerCell(pid, S.week)),
            h('td', { class: `r mono ${pts ? '' : 'dim'}`, style: pts ? 'font-weight:600' : '' }, empty ? '—' : (pts != null && (live || pts > 0) ? fmt1(pts) : '—')),
            h('td', { class: 'r mono dim' }, empty ? '' : fmt1(projOf(pid, S.week))),
            h('td', { class: 'mono dim' }, empty ? '' : g ? `${g.home ? 'vs' : '@'} ${g.opp} · ${DAY[new Date(g.date + 'T12:00:00').getDay()]}${g.status === 'in_game' ? ' ● live' : g.status === 'complete' ? ' · Final' : ''}` : isBye(pid, S.week) ? 'BYE' : '—')));
    });
    const startersSet = new Set((m.starters || []).filter(p => p && p !== '0'));
    for (const pid of (m.players || R.players || [])) if (!startersSet.has(pid)) { benchPts += (m.players_points || {})[pid] || 0; benchProj += projOf(pid, S.week) || 0; }
    tbl.append(h('tr', null, h('td', { colspan: 2, style: 'font-weight:800' }, 'Bench (not counting)'), h('td', { class: 'r mono dim' }, live ? fmt1(benchPts) : '—'), h('td', { class: 'r mono dim' }, fmt1(benchProj)), h('td', null)));
    return h('div', { class: 'card scroll-x' }, h('div', { class: 'card-h' }, h('h3', null, teamName(R)), mine ? h('span', { class: 'chip teal' }, S.myRoster && R.roster_id === S.myRoster.roster_id ? 'you' : record(R)) : h('span', { class: 'dim', style: 'font-size:12px' }, `weak slot: ${weakSlot(R, S.week) || '—'}`)), tbl);
}

// ── League ───────────────────────────────────────────────────────────────────
// The read-out: what this league's rules actually are, and how its draft went.
// Everything on the first two tabs is already in S.league at boot — the old
// modal simply chose to show 9 of 61 scoring rules and 11 of 50 settings, so
// the kicking, the whole defence, keepers, taxi and the veto rules were
// invisible. Commissioner edits stay Sleeper's screens; this is the read-out.
const LG_ZERO_HINT = 'worth 0 in this league';
async function loadDraftPicks() {
    const id = S.league && S.league.draft_id;
    if (!id || S.draftPicks || S.draftBusy) return;
    S.draftBusy = true;
    try {
        const [meta, picks] = await Promise.all([
            rest(`${API}/draft/${id}`).catch(() => null),
            rest(`${API}/draft/${id}/picks`).catch(() => []),
        ]);
        S.draftMeta = meta; S.draftPicks = picks || [];
    } catch (e) { S.draftPicks = []; console.warn(TAG, 'draft:', e.message); }
    finally { S.draftBusy = false; render(); }
}
const lgRow = (k, v, cls) => h('div', { class: `lgrow ${cls || ''}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
const lgGrp = (title, count, ...rows) => h('div', { class: 'lggrp' },
    h('h5', null, title, count != null ? h('span', { class: 'cnt' }, `${count} rule${count === 1 ? '' : 's'}`) : null), ...rows);
const yesNo = (b) => b ? 'yes' : 'no';
// ── the Season Sheet ─────────────────────────────────────────────────────────
// The League tab's standings, expanded. Not one of these numbers is computed
// here: FBCalc.computeSeasonSheet owns all of it.
//
// Twenty metrics do not fit across a table, and a table you scroll sideways is
// a table nobody reads: Seed, team and W–L are pinned, and a lens swaps the
// rest. Four settled weeks before the luck and manager lenses will show — a
// confident wrong number is worse than an absent one.
const SHEET_LENSES = [
    ['record', 'Record', 'the schedule, added and removed'],
    ['scoring', 'Scoring', 'what the roster actually does'],
    ['manager', 'Manager skill', 'decisions, priced'],
    ['luck', 'Luck', 'what you earned against what you got'],
    ['ahead', 'Playoffs', 'each team’s chances: seeds, the odds, and what this week is worth'],
];
// Overall, or the same rows under their divisions. Per viewer, like the other choices on this page.
function sheetGroup() {
    if (((S.league && S.league.settings) || {}).divisions < 2 || !((S.league && S.league.settings) || {}).divisions) return 'overall';
    if (S.ui.sheetGroup) return S.ui.sheetGroup;
    let v = 'overall'; try { v = localStorage.getItem('badgerSheetGroup') === 'division' ? 'division' : 'overall'; } catch (e) { /* default */ }
    return (S.ui.sheetGroup = v);
}
function setSheetGroup(v) { S.ui.sheetGroup = v; try { localStorage.setItem('badgerSheetGroup', v); } catch (e) { /* this visit only */ } render(); }
async function ensureSheetData() {
    await ensureLedgerData();                      // settled weeks, the draft, and the txns it wants
    // ensureLedgerData stops at S.curWeek, which is the LIVE NFL week: reading
    // a finished season it fetches week 1 and nothing else, and every waiver
    // column comes back empty. The sheet wants the whole regular season, plus
    // the weeks not played yet for strength of schedule.
    const jobs = [];
    for (let w = 1; w <= regSeasonEnd(); w++) {
        if (!S.matchups[w]) jobs.push(loadMatchups(w));
        if (!S.txns[w]) jobs.push(loadTxns(w).catch(() => {}));
    }
    if (jobs.length) await Promise.all(jobs);
}
// The week in progress, folded into the season sheet: each game counted at its
// projected final, every column and lens with it. (It used to count the score
// so far, "as it stands", which handed the week to whoever had played more men.) The
// switch is per viewer and holds for the week it was turned on in; once the
// next week starts it is off again.
const SHEET_LIVE_KEY = 'badgerSheetLive';
function sheetLiveAvail() {
    return S.seasonType === 'regular' && S.league && S.league.status === 'in_season' && S.curWeek <= regSeasonEnd()
        && (S.matchups[S.curWeek] || []).some((m) => (m.points || 0) > 0);
}
function sheetLiveOn() {
    if (!sheetLiveAvail()) return false;
    if (S.ui.sheetLive != null) return S.ui.sheetLive;
    try { return localStorage.getItem(SHEET_LIVE_KEY) === `${S.leagueId}:${S.curWeek}`; } catch (e) { return false; }
}
function setSheetLive(on) {
    S.ui.sheetLive = on;
    try { if (on) localStorage.setItem(SHEET_LIVE_KEY, `${S.leagueId}:${S.curWeek}`); else localStorage.removeItem(SHEET_LIVE_KEY); } catch (e) { /* the switch still works for this visit */ }
    render();
}
// The switch itself, the same on the Home card and the League tab.
function liveSwitch(focusKey) {
    if (!sheetLiveAvail()) return null;
    const on = sheetLiveOn();
    return h('span', { class: `lvsw${on ? ' on' : ''}`, role: 'switch', tabindex: '0', 'aria-checked': String(on), 'data-focus': focusKey,
        title: on ? `Showing the standings with this week counted ${liveWeekProjects() ? 'as it is projected to finish' : 'as it stands'}. Click for settled weeks only.` : liveWeekProjects() ? 'Count this week as it is projected to finish' : 'Count this week as it stands, as if it ended now',
        onclick: () => setSheetLive(!on), onkeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSheetLive(!on); } } },
        h('span', { class: 'tg' }), h('span', { class: 'dot' }), `Week ${S.curWeek} ${liveWord()}`);
}
// Under the Home card's table while it is on: when, how much is left, who crosses the line.
function homeLiveCap() {
    const seats = Math.min((S.league.settings || {}).playoff_teams || 6, S.rosters.length);
    const settledAt = {}; for (const R of S.rosters) settledAt[R.roster_id] = (stCtx.was[R.roster_id] || {}).n || 99;
    return sheetLiveCap(stCtx.seeds, settledAt, seats, 'Playoff % is the season forecast from the scores as they stand.');
}
function sheetInput(live) {
    if (!S.league || !S.rosters.length) return null;
    const end = regSeasonEnd(), weeks = {}, future = [];
    for (let w = 1; w <= end; w++) {
        const ms = S.matchups[w];
        if (!ms || !ms.length) continue;
        // A week is settled when somebody scored in it and it is not still being
        // played. S.curWeek is the LIVE NFL week, so it says nothing about a
        // finished season — reading a 2025 league in 2026, every scored week is
        // settled, and gating on w < curWeek would settle none of them.
        const over = S.league.status === 'complete' || S.seasonType === 'post' || S.curWeek > end;
        if (ms.some(m => (m.points || 0) > 0) && (over || w < S.curWeek || (live && w === S.curWeek))) {
            weeks[w] = ms.map(m => ({
                rosterId: m.roster_id, matchupId: m.matchup_id == null ? null : m.matchup_id,
                points: live && w === S.curWeek ? countedPoints(m) : m.points || 0, starters: m.starters || [], players: m.players || [],
                playerPoints: m.players_points || {},
            }));
        } else {
            const by = {};
            for (const m of ms) if (m.matchup_id != null) (by[m.matchup_id] = by[m.matchup_id] || []).push(m);
            for (const p of Object.values(by)) if (p.length === 2) future.push({ week: w, a: p[0].roster_id, b: p[1].roster_id });
        }
    }
    const txns = [];
    for (let w = 1; w <= end; w++) for (const t of (S.txns[w] || [])) txns.push({
        week: t.leg || w, type: t.type, status: t.status, rosterIds: t.roster_ids || [],
        adds: t.adds || null, drops: t.drops || null,
        bid: (t.settings && t.settings.waiver_bid != null) ? t.settings.waiver_bid : null,
    });
    // Multi-eligible players keep both slots ("RB,WR"), which is what eligOf reads.
    const positionOf = {};
    for (const w in weeks) for (const r of weeks[w]) for (const pid of r.players) {
        if (positionOf[pid] !== undefined) continue;
        const pl = P(pid);
        positionOf[pid] = (pl && pl.fantasy_positions && pl.fantasy_positions.length) ? pl.fantasy_positions.join(',') : (ppos(pid) || null);
    }
    const odds = {};
    // Each team's odds, once the season has been played out 3,000 times.
    if (!Object.keys(odds).length && S.po && S.po.res && S.po.res.teams && S.po.res.n) {
        const n = S.po.res.n;
        for (const [rid, t] of S.po.res.teams) odds[rid] = { in: t.in_ / n, bye: t.bye / n, magic: t.magic,
            seed: Object.fromEntries(Object.entries(t.seed || {}).map(([k, v]) => [String(k), v / n])),
            leverage: t.winN > n * 0.02 && t.loseN > n * 0.02 ? { win: t.winIn / t.winN, lose: t.loseIn / t.loseN } : null };
    }
    return {
        rosterIds: S.rosters.map(R => R.roster_id),
        division: Object.fromEntries(S.rosters.map(R => [R.roster_id, (R.settings || {}).division || 0])),
        slots: FBCalc.slotsFromRosterPositions(rosterPositions()),
        positionOf, weeks, futureGames: future, transactions: txns,
        draftPicks: (S.leagueDraftPicks || []).filter(p => p.player_id).map(p => ({ rosterId: p.roster_id, playerId: p.player_id })),
        odds,
    };
}
// The bitmask DP is ~30M operations over a full season — once, never per render.
function seasonSheet(live) {
    const inp = sheetInput(live); if (!inp) return null;
    // as it stands, every new point is a new sheet
    const liveKey = live ? (S.matchups[S.curWeek] || []).map((m) => `${m.roster_id}=${countedPoints(m)}`).join(',') : '';
    const key = `${Object.keys(inp.weeks).length}:${inp.futureGames.length}:${S.curWeek}:${liveKey}:${Object.keys(inp.odds || {}).length}:${(S.po && S.po.res && S.po.key) || ''}`;
    if (S.sheet && S.sheet.key === key) return S.sheet.val;
    let val = null;
    try { val = FBCalc.computeSeasonSheet(inp); }
    catch (e) { console.warn(TAG, 'season sheet:', e.message); return null; }
    S.sheet = { key, val };
    return val;
}
// ── micro-visualisations ─────────────────────────────────────────────────────
// Each is drawn at the size it appears in a row. The only question that matters
// is whether it reads at fifteen pixels tall.
const sv = (tag, attrs, ...kids) => { const e = document.createElementNS(SVG_NS, tag); for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]); for (const c of kids) if (c) e.appendChild(c); return e; };
function svSpark(t, lo, hi, mid) {
    const W = 96, H = 17, n = t.scores.length;
    if (n < 2) return h('span', { class: 'dim' }, '—');
    const x = i => (i / (n - 1)) * (W - 2) + 1, y = v => H - 1 - ((v - lo) / Math.max(1, hi - lo)) * (H - 2);
    const d = t.scores.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const g = sv('svg', { class: 'spark', width: W, height: H, viewBox: `0 0 ${W} ${H}` },
        sv('line', { x1: 0, y1: y(mid).toFixed(1), x2: W, y2: y(mid).toFixed(1), stroke: '#2a3345', 'stroke-dasharray': '2 2' }),
        sv('path', { d, fill: 'none', stroke: '#66738a', 'stroke-width': 1.2 }));
    t.scores.forEach((v, i) => g.appendChild(sv('circle', { cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: 1.5, fill: t.results[i] === 'W' ? '#20ceb8' : t.results[i] === 'L' ? '#ef5a5a' : '#98a4b8' })));
    g.appendChild(sv('title', {}));
    g.lastChild.textContent = t.scores.map((v, i) => `wk${i + 1} ${fmt1(v)} ${t.results[i] || ''}`).join(' · ');
    return g;
}
function svWhisk(t, lo, hi) {
    const W = 108, H = 15, x = v => ((v - lo) / Math.max(1, hi - lo)) * (W - 2) + 1;
    const g = sv('svg', { class: 'whisk', width: W, height: H, viewBox: `0 0 ${W} ${H}` },
        sv('line', { x1: x(t.floor).toFixed(1), y1: H / 2, x2: x(t.ceiling).toFixed(1), y2: H / 2, stroke: '#354060', 'stroke-width': 5, 'stroke-linecap': 'round' }),
        sv('line', { x1: x(t.floor).toFixed(1), y1: 3, x2: x(t.floor).toFixed(1), y2: H - 3, stroke: '#66738a', 'stroke-width': 1.4 }),
        sv('line', { x1: x(t.ceiling).toFixed(1), y1: 3, x2: x(t.ceiling).toFixed(1), y2: H - 3, stroke: '#66738a', 'stroke-width': 1.4 }),
        sv('circle', { cx: x(t.mean).toFixed(1), cy: H / 2, r: 3.2, fill: '#20ceb8' }),
        sv('title', {}));
    g.lastChild.textContent = `floor ${fmt1(t.floor)} · mean ${fmt1(t.mean)} · ceiling ${fmt1(t.ceiling)}`;
    return g;
}
function svDumb(t) {
    const W = 112, H = 15, g2 = Math.max(1, t.games), exp = t.wins + 0.5 * t.ties - t.luck;
    const x = v => (v / g2) * (W - 10) + 5;
    const col = t.luck > 0.5 ? '#4fc46c' : t.luck < -0.5 ? '#e8b04b' : '#66738a';
    const g = sv('svg', { class: 'dumb', width: W, height: H, viewBox: `0 0 ${W} ${H}` },
        sv('line', { x1: 5, y1: H / 2, x2: W - 5, y2: H / 2, stroke: '#232b3a' }),
        sv('line', { x1: x(exp).toFixed(1), y1: H / 2, x2: x(t.wins).toFixed(1), y2: H / 2, stroke: col, 'stroke-width': 3 }),
        sv('circle', { cx: x(exp).toFixed(1), cy: H / 2, r: 2.6, fill: '#66738a' }),
        sv('circle', { cx: x(t.wins).toFixed(1), cy: H / 2, r: 3.4, fill: col }),
        sv('title', {}));
    g.lastChild.textContent = `all-play expected ${exp.toFixed(1)} wins · actually won ${t.wins}`;
    return g;
}
// The whole seed distribution, not the one number we usually draw out of it.
const SEED_INK = ['#20ceb8', '#1aa693', '#5b9cf5', '#4a7fc9', '#3c6499', '#2f4b73', '#26608f', '#1f5075'];
function elSeedbar(t, seats) {
    const o = t.odds;
    if (!o) return h('span', { class: 'dim' }, '—');
    const bar = h('div', { class: 'seedbar', title: `seed 1–${seats}, then missing out` });
    let shown = 0;
    for (let i = 1; i <= seats; i++) {
        const p = (o.seed && o.seed[String(i)]) || 0; shown += p;
        if (p > 0.004) bar.append(h('i', { style: `width:${(p * 100).toFixed(2)}%;background:${SEED_INK[i - 1] || SEED_INK[SEED_INK.length - 1]}`, title: `seed ${i}: ${Math.round(p * 100)}%` }));
    }
    const out = Math.max(0, 1 - shown);
    if (out > 0.004) bar.append(h('i', { style: `width:${(out * 100).toFixed(2)}%;background:#232b3a`, title: `misses: ${Math.round(out * 100)}%` }));
    return bar;
}
function elHeat(t) {
    const s = h('span', { class: 'heat', title: t.results.map((r, i) => `wk${i + 1} ${r}`).join(' ') });
    for (const r of t.results) s.append(h('i', { class: r === 'W' ? 'w' : r === 'L' ? 'l' : 't' }));
    return s;
}
// What "as it stands" rests on right now: when, how much football is left, who
// crosses the playoff line.
function sheetLiveCap(seeds, settledAt, seats, tail) {
    const left = (S.matchups[S.curWeek] || []).reduce((n, m) => n + (m.starters || []).filter((pid) => pid && pid !== '0' && gameFracLeft(pid) > 0).length, 0);
    const now = new Date(), hr = now.getHours() % 12 || 12, at = `${DAY[now.getDay()]} ${hr}:${String(now.getMinutes()).padStart(2, '0')}${now.getHours() < 12 ? 'a' : 'p'}`;
    const seatOf = (rid) => (seeds && seeds[rid] ? seeds[rid].n : 99);   // no seed is outside the seats
    const cross = Object.keys(settledAt).map(Number).filter((rid) => (settledAt[rid] <= seats) !== (seatOf(rid) <= seats));
    const said = cross.map((rid) => `${teamName(rosterById(rid))} ${seatOf(rid) <= seats ? 'moves above' : 'drops below'} the line`);
    return h('div', { class: 'lvcap' }, h('b', null, `Week ${S.curWeek} ${liveWord()}`), `, ${at} · `,
        left ? `${left} starter${left === 1 ? '' : 's'} still to play` : 'every starter has played',
        ` · ${said.length ? said.join(', ') : 'no one crosses the playoff line'}. ${tail || (liveWeekProjects() ? `Every column counts week ${S.curWeek} at its projected final: the points so far plus what the starters still to play are projected for.` : `Every column counts week ${S.curWeek} as if it ended now.`)}`);
}
// ── the tab ──────────────────────────────────────────────────────────────────
function lgStandingsTab() {
    if (!S.sheetReady) {
        if (!S.sheetBusy) {
            S.sheetBusy = true;
            ensureSheetData().then(() => { S.sheetReady = true; S.sheetBusy = false; render(); }).catch((e) => { S.sheetBusy = false; S.sheetReady = true; console.warn(TAG, 'sheet data:', e.message); render(); });
        }
        return h('div', { class: 'cap' }, h('span', { class: 'spin' }), ' Reading the season back…');
    }
    const live = sheetLiveOn();
    const SH = seasonSheet(live);
    if (!SH) return h('div', { class: 'empty' }, 'Nothing to settle yet — this league has not played a week.');
    if (!SH.weeks.length) return h('div', { class: 'empty' }, 'No completed weeks yet. The sheet fills in from week 2.');

    const seats = Math.min((S.league.settings || {}).playoff_teams || 6, S.rosters.length);
    const seeds = currentSeeds(live);
    const rows = SH.rows.slice();
    if (seeds) rows.sort((a, b) => ((seeds[a.rosterId] || {}).n || 99) - ((seeds[b.rosterId] || {}).n || 99));
    // as it stands: where each team sat on settled weeks, and this week's game so far
    // (every team's place in the settled table, ordered the way the table orders
    // it: the seeding rules name only the playoff seats, the rest follow in turn)
    const settledAt = {};
    if (live) {
        const s0 = currentSeeds(false), r0 = (seasonSheet(false) || { rows: [] }).rows.slice();
        if (s0) r0.sort((a, b) => ((s0[a.rosterId] || {}).n || 99) - ((s0[b.rosterId] || {}).n || 99));
        r0.forEach((t, i) => { settledAt[t.rosterId] = s0 && s0[t.rosterId] ? s0[t.rosterId].n : i + 1; });
    }
    const wk = {}; for (const m of (live ? S.matchups[S.curWeek] || [] : [])) wk[m.roster_id] = m;
    const wkOpp = (rid) => { const m = wk[rid]; if (!m || m.matchup_id == null) return null; return Object.values(wk).find((x) => x.matchup_id === m.matchup_id && x.roster_id !== rid) || null; };
    const wkPts = (rid) => { const m = wk[rid]; return m ? countedPoints(m) : null; };
    const wkRes = (rid) => { const m = wk[rid], o = wkOpp(rid); if (!m || !o) return null; const a = countedPoints(m), b = countedPoints(o); return a > b ? 'W' : a < b ? 'L' : 'T'; };
    const verdict = {};
    for (const v of SH.verdicts) verdict[v.rosterId] = v;
    const nDiv = (S.league.settings || {}).divisions || 0, byDiv = sheetGroup() === 'division';

    let lens = S.ui.sheetLens || 'record';
    const blocked = (k) => (k === 'luck' && SH.thin.luck) || (k === 'manager' && SH.thin.manager) || (k === 'scoring' && SH.thin.shape);
    if (blocked(lens)) lens = 'record';
    if (lens === 'ahead') poRun();   // the Playoffs view needs the odds; nothing else on this tab asks for them
    // Who each team has had to beat: every week the league's scores are ranked, 1 for the
    // week's top scorer, and a team's number is the average rank of the opponents it met.
    const oppRank = {}, nTeams = S.rosters.length;
    for (const w of SH.weeks) {
        const ms = (S.matchups[w] || []).filter((m) => m.matchup_id != null);
        const order = ms.slice().sort((x, y) => (y.points || 0) - (x.points || 0)), rk = {}; order.forEach((m, i) => { rk[m.roster_id] = i + 1; });
        for (const m of ms) { const o = ms.find((x) => x.matchup_id === m.matchup_id && x.roster_id !== m.roster_id); if (!o) continue; const e = oppRank[m.roster_id] || (oppRank[m.roster_id] = { sum: 0, n: 0 }); e.sum += rk[o.roster_id]; e.n++; }
    }
    const oppRankOf = (rid) => (oppRank[rid] && oppRank[rid].n ? oppRank[rid].sum / oppRank[rid].n : null);

    const allScores = rows.flatMap(t => t.scores);
    const lo = Math.min(...allScores), hi = Math.max(...allScores);
    const mid = allScores.reduce((a, b) => a + b, 0) / Math.max(1, allScores.length);
    const wlo = Math.min(...rows.map(t => t.floor)) - 4, whi = Math.max(...rows.map(t => t.ceiling)) + 4;

    const m = (txt, cls) => h('span', { class: `mono ${cls || ''}` }, txt);
    const pc = (x, d) => `${(x * 100).toFixed(d == null ? 0 : d)}%`;
    const sg = (x, d) => { const t = x.toFixed(d == null ? 1 : d); return Number(t) === 0 ? t.replace('-', '') : `${x > 0 ? '+' : ''}${t}`; };   // a value that rounds to zero is 0, not "-0"
    const LENS = {
        record: {
            head: [['PF'], ['PA'], ['All-play', 'Your record against every team every week — the schedule removed'], ['Luck', 'Wins minus what all-play expected of you'], ['Sched pts', 'Points faced against the league average'], ['1-score', 'Record in games decided by under 10'], ['Highs', 'Weeks you were the league top scorer']],
            row: t => [[m(fmt1(t.pointsFor)), live && wk[t.rosterId] ? h('span', { class: 'lvsub' }, `+${fmt1(wkPts(t.rosterId))} ${liveWeekProjects() ? 'proj' : 'live'}`) : null],   // the figure the total beside it added
                [m(fmt1(t.pointsAgainst), 'dim'), live && wkOpp(t.rosterId) ? h('span', { class: 'lvsub' }, `+${fmt1(countedPoints(wkOpp(t.rosterId)))}`) : null],
                m(`${Math.round(t.allPlayW)}–${Math.round(t.allPlayL)}`),
                m(sg(t.luck), t.luck > 0.5 ? 'green' : t.luck < -0.5 ? 'amber' : 'dim'),
                m(sg(t.schedulePoints, 0), t.schedulePoints > 60 ? 'amber' : t.schedulePoints < -60 ? 'green' : 'dim'),
                m(`${t.oneScoreW}–${t.oneScoreL}`, t.oneScoreL > t.oneScoreW ? 'red' : t.oneScoreW > t.oneScoreL ? 'green' : 'dim'),
                m(t.weeklyHighs || '—', t.weeklyHighs >= 3 ? 'teal' : t.weeklyHighs ? '' : 'dim')],
        },
        scoring: {
            head: [['Mean'], ['σ', 'How far a typical week sits from your average — metronome or boom-bust'], ['Floor → ceiling', 'The 15th and 85th percentile week; the dot is the mean'], ['Season', 'Every week — teal won, red lost, dashed line is the league average week'], ['Form', 'Week by week, first to last']],
            row: t => [m(fmt1(t.mean)), m(fmt1(t.sd), t.sd > 27 ? 'amber' : t.sd < 17 ? 'blue' : 'dim'),
                svWhisk(t, wlo, whi), svSpark(t, lo, hi, mid), elHeat(t)],
        },
        manager: {
            head: [['Eff', 'Points scored ÷ the best legal lineup you could have started'], ['Bench lost', 'What a better call would have kept'], ['Perfect', 'Weeks your lineup WAS the best one available'], ['Self-inflicted', 'Losses your own optimal lineup would have won'], ['Adds'], ['Bids lost', 'Failed waiver claims — Sleeper returns those with the bid attached'], ['$/pt', 'FAAB spent per point your pickups actually started']],
            row: t => [m(pc(t.efficiency, 1), t.efficiency >= 0.92 ? 'green' : t.efficiency < 0.89 ? 'amber' : ''),
                m(fmt1(t.benchLost), 'red'),
                m(t.perfectWeeks || '—', t.perfectWeeks >= 3 ? 'teal' : 'dim'),
                m(t.selfInflicted || '—', t.selfInflicted >= 3 ? 'red' : t.selfInflicted ? 'amber' : 'dim'),
                m(t.adds, 'dim'),
                m(t.failedBids, t.failedBids >= 20 ? 'amber' : 'dim'),
                m(t.waiverRoi == null ? '—' : `$${t.waiverRoi.toFixed(2)}`, 'dim')],
        },
        luck: {
            head: [['Expected → actual', 'All-play expected wins, then what you actually won'], ['Luck'], ['All-play %'],
                ['Opp rank', `The average weekly scoring rank of the opponents you have met, out of ${nTeams}: 1 would be the week’s top scorer every week, ${nTeams} the lowest`],
                ['1-score'], ['Unluckiest week', 'Your highest-scoring loss']],
            row: t => { const or = oppRankOf(t.rosterId); return [svDumb(t), m(sg(t.luck), t.luck > 0.5 ? 'green' : t.luck < -0.5 ? 'amber' : 'dim'),
                m(pc(t.allPlayPct)),
                m(or == null ? '—' : or.toFixed(1), or == null ? 'dim' : or <= nTeams * 0.38 ? 'amber' : or >= nTeams * 0.62 ? 'green' : 'dim'),
                m(`${t.oneScoreW}–${t.oneScoreL}`, t.oneScoreL > t.oneScoreW ? 'red' : 'dim'),
                t.unluckiest ? h('span', { class: 'dim', style: 'font-size:11.5px' }, `wk${t.unluckiest.week} · ${fmt1(t.unluckiest.points)} vs ${fmt1(t.unluckiest.oppPoints)}`) : h('span', { class: 'dim' }, '—')]; },
        },
        ahead: {
            head: [[`Seed 1–${seats} · miss`, 'The whole distribution, not the one number we usually draw out of it'], ['Playoff %'], ['Bye %'], ['If W → if L', 'Your playoff odds if you win this week, against if you lose'], ['Leverage', 'How much this Sunday is worth'], ['SOS left', 'Mean all-play % of the opponents you have left']],
            row: t => {
                const o = t.odds, lev = o && o.leverage;
                return [elSeedbar(t, seats),
                    m(o ? pc(o.in) : '—', o && o.in >= 0.6 ? 'teal' : o && o.in < 0.2 ? 'dim' : ''),
                    m(o && o.bye ? pc(o.bye) : '—', o && o.bye >= 0.3 ? 'teal' : 'dim'),
                    m(lev ? `${Math.round(lev.win * 100)} → ${Math.round(lev.lose * 100)}` : '—', 'dim'),
                    m(lev ? `${Math.round((lev.win - lev.lose) * 100)}pp` : '—', lev && (lev.win - lev.lose) >= 0.4 ? 'amber' : 'dim'),
                    m(t.sosRemaining == null ? '—' : pc(t.sosRemaining), t.sosRemaining >= 0.54 ? 'amber' : t.sosRemaining <= 0.48 ? 'green' : 'dim')];
            },
        },
    };
    const L = LENS[lens];
    const tbl = h('table', { class: 'shtbl' },
        h('tr', null, h('th', { class: 'l' }, 'Team'), h('th', { class: 'c' }, 'W–L'),
            ...L.head.map(([c, tip]) => h('th', { title: tip || null }, c))),
        ...(() => {
            const place = {}; rows.forEach((t, i) => { place[t.rosterId] = i + 1; });
            const rowEl = (t, cut) => {
                const R = rosterById(t.rosterId), sd = seeds && seeds[t.rosterId], v = verdict[t.rosterId], at = sd ? sd.n : place[t.rosterId];
                const mine = S.myRoster && t.rosterId === S.myRoster.roster_id, was = settledAt[t.rosterId];
                return h('tr', { class: `${mine ? 'me' : ''} ${cut ? 'cut' : ''}`, style: 'cursor:pointer', title: `Open ${teamName(R)}`, onclick: () => goTeam(t.rosterId) },
                    h('td', { class: 'l' }, h('div', { class: 'shteam' },
                        h('span', { class: `shseed ${sd && sd.bye ? 'bye' : place[t.rosterId] <= seats ? 'in' : ''}` }, at),
                        // as it stands, every row keeps the mover's slot, filled or not, so the names line up
                        !live ? null : was && was !== at
                            ? h('span', { class: `lvmv ${was > at ? 'up' : 'dn'}`, title: `${ordinal(was)} on settled weeks` }, `${was > at ? '▲' : '▼'}${Math.abs(was - at)}`)
                            : h('span', { class: 'lvmv', 'aria-hidden': 'true' }),
                        avatarEl(R, 'sm'),
                        h('span', { class: `shnm ${mine ? 'teal' : ''}` }, teamName(R)),
                        // the tag carries its own reason now that the three cards above the table are gone
                        v ? h('span', { class: `vchip v-${v.key}`, title: verdictWhy(v, t) }, v.label) : null)),
                    h('td', { class: 'c mono' }, `${t.wins}–${t.losses}${t.ties ? '–' + t.ties : ''}`, live && wkRes(t.rosterId) ? h('span', { class: 'lvres', title: `Week ${S.curWeek} ${liveWord()}: ${fmtS(wkPts(t.rosterId))}–${fmtS(wkOpp(t.rosterId) ? countedPoints(wkOpp(t.rosterId)) : null)}` }, h('i'), wkRes(t.rosterId)) : null),
                    ...L.row(t).map(c => h('td', null, c)));
            };
            if (!byDiv) return rows.map((t, i) => rowEl(t, i === seats - 1));
            // by division: the same rows under their division's name, in the same order; the seed numbers still say who is in
            const meta = S.league.metadata || {}, out = [], divOf = (t) => ((rosterById(t.rosterId) || {}).settings || {}).division || 0;
            for (let d = 1; d <= nDiv; d++) {
                const mineD = rows.filter((t) => divOf(t) === d); if (!mineD.length) continue;
                out.push(h('tr', { class: 'secrow' }, h('td', { colspan: 2 + L.head.length }, h('b', null, meta[`division_${d}`] || `Division ${d}`))));
                for (const t of mineD) out.push(rowEl(t, false));
            }
            return out;
        })());

    // The controls sit the way the Players tab's do: labelled groups in one row. Lens is how the
    // table is arranged (overall, or by division); View is which columns it shows.
    const grp = (label, ...kids) => h('div', { class: 'fgroup' }, h('span', { class: 'flab' }, label), ...kids);
    return h('div', null,
        h('div', { class: 'filters fbrow lgview' },
            nDiv >= 2 ? grp('Lens', h('div', { class: 'tabs' }, ...[['overall', 'Overall', 'Every team in one table, the playoff seats first'], ['division', 'By division', 'The same teams under their divisions']].map(([k, label, tip]) =>
                h('span', { class: (byDiv ? 'division' : 'overall') === k ? 'on' : '', title: tip, onclick: () => setSheetGroup(k) }, label)))) : null,
            grp('View', h('div', { class: 'tabs' }, ...SHEET_LENSES.map(([k, label, note]) => h('span', {
                class: `${k === lens ? 'on' : ''} ${blocked(k) ? 'off' : ''}`,
                style: k === lens ? 'background:var(--blue);border-color:var(--blue);color:#fff' : '',
                title: blocked(k) ? 'Needs four settled weeks — three is noise, not a season' : note,
                onclick: () => { if (blocked(k)) return; S.ui.sheetLens = k; render(); },
            }, label)))),
            liveSwitch('sheetlive'),
            h('span', { class: 'dim', style: 'font-size:11.5px;margin-left:auto' }, (SHEET_LENSES.find(x => x[0] === lens) || [])[2] || '')),
        h('div', { class: 'scroll-x', style: 'margin-top:10px' }, tbl),
        live ? sheetLiveCap(seeds, settledAt, seats) : null,
        h('div', { class: 'cap', style: 'margin-top:8px' },
            `Weeks 1–${SH.weeks[SH.weeks.length - 1]}${live ? `, week ${S.curWeek} ${liveWord()}` : ''} · ${byDiv ? `a teal number is one of the ${seats} playoff seats` : 'the dashed line is the playoff cut'} · click a team to open it.`,
            SH.thin.luck ? ' Luck and Manager need four settled weeks.' : '',
            seeds && seedingNote() ? ` ${seedingNote()}` : '',
            lens === 'ahead' && !Object.keys((sheetInput() || {}).odds || {}).length ? ' The odds are still being worked out; this view fills in when they land.' : ''));
}
// The chip states the verdict; this states the evidence, in the same words the
// lens uses. Every clause is a number off the row — never an opinion.
function verdictWhy(v, t) {
    if (!t) return '';
    switch (v.key) {
        case 'paperChampion': return `Best all-play in the league at ${Math.round(t.allPlayW)}–${Math.round(t.allPlayL)}, and not top of the table.`;
        case 'highwire': return `${t.wins}–${t.losses} on a ${Math.round(t.allPlayW)}–${Math.round(t.allPlayL)} all-play — ${sgnw(t.luck)} wins of schedule.`;
        case 'robbed': return t.oneScoreL >= 3 && !t.oneScoreW ? `${t.oneScoreW}–${t.oneScoreL} in one-score games.${t.unluckiest ? ` Week ${t.unluckiest.week}: ${fmt1(t.unluckiest.points)}, lost by ${fmt1(t.unluckiest.oppPoints - t.unluckiest.points)}.` : ''}` : `${sgnw(t.luck)} wins against an average schedule.`;
        case 'boomBust': return `σ of ${fmt1(t.sd)} — floor ${fmt1(t.floor)}, ceiling ${fmt1(t.ceiling)}${t.weeklyHighs ? `, ${t.weeklyHighs} weekly high${t.weeklyHighs === 1 ? '' : 's'}` : ''}.`;
        case 'metronome': return `σ of ${fmt1(t.sd)} — never above ${fmt1(Math.max(...t.scores))}, never below ${fmt1(Math.min(...t.scores))}.`;
        case 'selfInflicted': return `${t.selfInflicted} losses their own bench would have won. Efficiency ${(t.efficiency * 100).toFixed(1)}%, ${fmt1(t.benchLost)} points left behind.`;
        case 'gauntlet': return `Faced ${sgnw(t.schedulePoints, 0)} points against the average schedule — the most in the league.`;
        case 'freeRide': return `${t.wins}–${t.losses} off a ${Math.round(t.allPlayW)}–${Math.round(t.allPlayL)} all-play, and ${fmt1(Math.abs(t.schedulePoints))} fewer points faced than average.`;
        case 'triggerHappy': return `${t.adds} adds and ${t.failedBids} losing bids — outbid more often than anyone.`;
        case 'oneAndDone': return `${t.adds} adds all season${t.avgBid != null ? ` at $${t.avgBid.toFixed(2)} a bid` : ''}, and an all-play of ${(t.allPlayPct * 100).toFixed(0)}%.`;
        case 'perfectPointless': return `${t.perfectWeeks} perfect lineups, and a ${t.wins}–${t.losses} record. Managed the roster it had.`;
        case 'theCeiling': return `${fmt1(t.ceiling)} at the 85th percentile — the highest ceiling in the league.`;
        default: return '';
    }
}
const sgnw = (x, d) => `${x > 0 ? '+' : ''}${x.toFixed(d == null ? 1 : d)}`;

function lgSettingsTab() {
    const st = S.league.settings || {}, rp = rosterPositions();
    const wi = waiverInfo();
    // Which designations may sit on IR is what the DO line's red IR row is
    // computed from; nothing on this page ever said so.
    const irAllows = [['out', 'OUT'], ['doubtful', 'DOUBTFUL'], ['sus', 'SUS'], ['na', 'NA'], ['cov', 'COV'], ['dnr', 'DNR']]
        .filter(([k]) => st['reserve_allow_' + k]).map(([, l]) => l);
    const hr = (h2) => (h2 % 12 || 12) + (h2 < 12 ? 'a' : 'p');
    return h('div', null,
        h('div', { class: 'lgsumm' }, h('b', null, `${st.num_teams || S.rosters.length}-team`),
            (st.divisions || 0) >= 2 ? [' · ', h('b', null, `${st.divisions} divisions`)] : null,
            ' · ', scoringLabel(), ' · ',
            h('b', null, wi.faab ? `FAAB $${st.waiver_budget}` : 'rolling waivers'),
            st.max_keepers ? [' · ', h('b', null, `${st.max_keepers} keeper${st.max_keepers === 1 ? '' : 's'}`)] : null,
            ' · playoffs week ', String(st.playoff_week_start || '?'), ', ', String(st.playoff_teams || '?'), ' teams'),
        h('div', { class: 'lineupchips' }, ...rp.map(p => slotChip(p))),   // a flex slot is the blend of what it takes; a bare .pos FLEX had no colour
        h('div', { class: 'lgcols' },
            lgGrp('Roster', null,
                lgRow('Starters', String(rp.filter(p => p !== 'BN' && p !== 'IR' && p !== 'TAXI').length)),
                lgRow('Bench', String(rp.filter(p => p === 'BN').length)),
                lgRow('IR slots', String(st.reserve_slots || 0), st.reserve_slots ? '' : 'off'),
                lgRow('IR may hold', st.reserve_slots ? (irAllows.length ? irAllows.join(', ') : 'IR only') : '—', st.reserve_slots ? 'warn' : 'off'),
                lgRow('Taxi slots', st.taxi_slots ? `${st.taxi_slots} · ${st.taxi_years || 0}yr` : 'none', st.taxi_slots ? '' : 'off'),
                lgRow('Max keepers', String(st.max_keepers || 0), st.max_keepers ? '' : 'off')),
            lgGrp('Waivers', null,
                lgRow('Type', wi.faab ? `FAAB · $${st.waiver_budget}` : st.waiver_type === 1 ? 'reverse standings' : 'rolling'),
                lgRow('Minimum bid', wi.faab ? `$${st.waiver_bid_min || 0}` : '—', wi.faab ? '' : 'off'),
                lgRow('Runs', runsWhen()),
                lgRow('Clear days', String(st.waiver_clear_days ?? '—')),
                lgRow('FAAB suggestions', yesNo(st.faab_suggestions), st.faab_suggestions ? '' : 'off'),
                lgRow('Adds disabled', yesNo(st.disable_adds), st.disable_adds ? 'warn' : 'off')),
            lgGrp('Trades', null,
                lgRow('Deadline', st.trade_deadline ? `week ${st.trade_deadline}` : 'none'),
                lgRow('Review period', st.trade_review_days != null ? `${st.trade_review_days} days` : '—'),
                lgRow('Veto votes needed', String(st.veto_votes_needed ?? '—')),
                lgRow('Show votes', yesNo(st.veto_show_votes), st.veto_show_votes ? '' : 'off'),
                lgRow('Pick trading', yesNo(st.pick_trading), st.pick_trading ? '' : 'off'),
                lgRow('Trades disabled', yesNo(st.disable_trades), st.disable_trades ? 'warn' : 'off')),
            lgGrp('Playoffs', null,
                lgRow('Teams', String(st.playoff_teams ?? '—')),
                lgRow('Starts', st.playoff_week_start ? `week ${st.playoff_week_start}` : '—'),
                lgRow('Round length', st.playoff_round_type === 1 ? 'two-week final' : st.playoff_round_type === 2 ? 'two weeks per round' : 'one week each'),
                lgRow('Seeding', st.playoff_seed_type ? 're-seed each round' : 'fixed bracket'),
                lgRow('Divisions', String(st.divisions || 0), st.divisions ? '' : 'off')),
            lgGrp('Season', null,
                lgRow('Teams', String(st.num_teams ?? S.rosters.length)),
                lgRow('Starts', st.start_week ? `week ${st.start_week}` : '—'),
                lgRow('Bench lock', yesNo(st.bench_lock), st.bench_lock ? '' : 'off'),
                lgRow('Best ball', yesNo(st.best_ball), st.best_ball ? '' : 'off'),
                lgRow('League-average match', yesNo(st.league_average_match), st.league_average_match ? '' : 'off'),
                lgRow('Offseason adds', yesNo(st.offseason_adds), st.offseason_adds ? '' : 'off'))));
}
// Sixty-one rules is a wall, so they are grouped by the thing they score and
// the ones worth nothing fold away — "what actually scores" needs no baseline.
const SC_LBL = { pass_yd: 'Passing yard', pass_td: 'Passing TD', pass_int: 'Interception thrown', pass_2pt: '2-pt pass', pass_sack: 'Sack taken',
    rush_yd: 'Rushing yard', rush_td: 'Rushing TD', rush_2pt: '2-pt rush', rec: 'Reception', rec_yd: 'Receiving yard', rec_td: 'Receiving TD', rec_2pt: '2-pt catch',
    fum: 'Fumble', fum_lost: 'Fumble lost', fum_rec: 'Fumble recovered', fum_rec_td: 'Fumble return TD',
    fgm: 'Field goal', xpm: 'Extra point', xpmiss: 'Extra point missed', fgmiss: 'Field goal missed',
    sack: 'Sack', int: 'Interception', safe: 'Safety', blk_kick: 'Blocked kick', ff: 'Forced fumble', tkl_loss: 'Tackle for loss',
    def_pass_def: 'Pass defended', def_3_and_out: 'Three-and-out', def_4_and_stop: '4th-down stop', def_td: 'Defensive TD',
    def_2pt: '2-pt return', st_td: 'Special-teams TD', def_st_td: 'D/ST return TD',
    st_ff: 'ST forced fumble', def_st_ff: 'D/ST forced fumble', st_fum_rec: 'ST fumble recovered', def_st_fum_rec: 'D/ST fumble recovered' };
const scLabel = (k) => SC_LBL[k] || k
    .replace(/^fgm_/, 'FG ').replace(/^fgmiss_/, 'FG miss ').replace(/^pts_allow_?/, 'Points allowed ')
    .replace(/^yds_allow_?/, 'Yards allowed ').replace(/^def_st_/, 'D/ST ').replace(/^def_/, 'Def ').replace(/^st_/, 'ST ')
    .replace(/_/g, ' ').replace(/(\d+)p\b/, '$1+').replace(/(\d+) (\d+)/, '$1–$2');
const scNum = (k) => Number((String(k).match(/\d+/) || [0])[0]);
function lgScoringTab() {
    const sc = S.league.scoring_settings || {};
    const keys = Object.keys(sc);
    const used = new Set();
    const take = (re, sort) => { const out = keys.filter(k => !used.has(k) && re.test(k)); out.forEach(k => used.add(k)); return sort ? out.sort((a, b) => scNum(a) - scNum(b)) : out.sort(); };
    const groups = [
        ['Passing', take(/^pass_/)],
        ['Rushing', take(/^rush_/)],
        ['Receiving', take(/^rec($|_)/)],
        ['Fumbles', take(/^fum/)],
        ['Kicking', take(/^(fgm|xpm|fgmiss|xpmiss)/, true)],
        ['Defence — plays', take(/^(def_|st_|sack|int$|safe|blk_kick|ff$|tkl)/)],
        ['Defence — points allowed', take(/^pts_allow/, true)],
        ['Defence — yards allowed', take(/^yds_allow/, true)],
    ];
    const leftovers = keys.filter(k => !used.has(k));
    if (leftovers.length) groups.push(['Other', leftovers.sort()]);
    const showZeros = !!S.ui.lgZeros;
    const total = keys.filter(k => sc[k]).length;
    const dst = groups.filter(([t]) => /Defence/.test(t)).reduce((n, [, ks]) => n + ks.filter(k => sc[k]).length, 0);
    return h('div', null,
        h('div', { class: 'lgsumm' }, scoringLabel(), ' · ', h('b', null, `${sc.rec ?? 0} a catch`),
            ' · ', h('b', null, `${sc.pass_td ?? 0}-point`), ' passing TDs, ', h('b', null, `${sc.rush_td ?? 0}-point`), ' rushing',
            ' · ', h('b', null, `${total} rules score`), ' in all, ', h('b', null, `${dst}`), ' of them for the defence.'),
        h('div', { class: 'lgcols' }, ...groups.map(([title, ks]) => {
            const live = ks.filter(k => sc[k]), zero = ks.filter(k => !sc[k]);
            if (!live.length && !zero.length) return null;
            return lgGrp(title, live.length,
                ...live.map(k => lgRow(scLabel(k), String(sc[k]), sc[k] < 0 ? 'neg' : '')),
                ...(showZeros ? zero.map(k => lgRow(scLabel(k), '0', 'zero')) : []),
                zero.length && !showZeros ? h('div', { class: 'lgrow zero click', onclick: () => { S.ui.lgZeros = true; render(); } },
                    h('span', { class: 'k' }, `${zero.length} ${LG_ZERO_HINT}`), h('span', { class: 'v show' }, 'show')) : null);
        })),
        showZeros ? h('div', { class: 'cap', style: 'margin-top:8px', onclick: () => { S.ui.lgZeros = false; render(); } },
            h('span', { class: 'lnk' }, 'Hide the rules worth 0')) : null);
}
function lgDraftTab() {
    const id = S.league && S.league.draft_id;
    if (!id) return h('div', { class: 'empty' }, 'This league has no draft on file.');
    // Never chain render onto a loader that can return without awaiting: once
    // S.seasonStats is warm loadSeasonStats() resolves in a microtask, and
    // render -> tab -> resolve -> render starves the macrotask queue, so the
    // draft fetch below can never land. loadDraftPicks re-renders on its own.
    if (!S.draftPicks) { loadDraftPicks(); if (!S.seasonStats) loadSeasonStats().then(render).catch(() => {}); return h('div', { class: 'cap' }, h('span', { class: 'spin' }), ' Reading the draft board…'); }
    const picks = S.draftPicks;
    if (!picks.length) return h('div', { class: 'empty' }, 'No picks on file for this draft.');
    const meta = S.draftMeta || {}, dst = meta.settings || {};
    const teams = dst.teams || S.rosters.length || 12;
    const view = S.ui.draftView || 'round';
    // Points scored so far, which is the honest column today. "Value against
    // the slot" wants a baseline this league does not have yet — see the note.
    const ptsOf = (pid) => { const r = (S.seasonStats || {})[pid]; return r ? r.pts : null; };
    const slot = (p) => `${p.round}.${String(p.pick_no - (p.round - 1) * teams).padStart(2, '0')}`;
    const teamOf = (rid) => { const R = rosterById(rid); return R ? teamName(R) : `Roster ${rid}`; };
    const posOf = (p) => (p.metadata && p.metadata.position) || ppos(p.player_id);
    const nameOf = (p) => (p.metadata && `${p.metadata.first_name || ''} ${p.metadata.last_name || ''}`.trim()) || pname(p.player_id);
    const ptsCell = (pid) => { const v = ptsOf(pid); return h('span', { class: `dpts${v == null ? ' none' : ''}` }, v == null ? '—' : fmt1(v)); };
    const head = h('div', null,
        h('div', { class: 'lgsumm' }, h('b', null, meta.type ? meta.type[0].toUpperCase() + meta.type.slice(1) : 'Draft'),
            dst.rounds ? ` · ${dst.rounds} rounds` : '', ` · ${teams} teams · `, h('b', null, `${picks.length} picks`),
            (S.league.settings || {}).max_keepers ? ` · ${(S.league.settings || {}).max_keepers} keeper each` : '',
            S.seasonStats && Object.keys(S.seasonStats).length ? ' · points are this season so far' : ' · no points scored yet this season'),
        h('div', { class: 'lgview' }, h('span', { class: 'muted' }, 'VIEW'),
            h('div', { class: 'seg' }, ...[['round', 'By round'], ['team', 'By team']].map(([k, t]) =>
                h('span', { class: k === view ? 'on' : '', onclick: () => { S.ui.draftView = k; render(); } }, t)))));
    if (view === 'round') {
        const tbl = h('table', { class: 'dtbl' });
        let last = 0;
        for (const p of picks.slice().sort((a, b) => a.pick_no - b.pick_no)) {
            if (p.round !== last) { last = p.round; tbl.append(h('tr', { class: 'secrow' }, h('td', { colspan: 4 }, h('b', null, `Round ${p.round}`)))); }
            tbl.append(h('tr', null,
                h('td', { class: 'mono dim dno' }, slot(p)),
                h('td', null, h('span', { class: `pos ${posOf(p) === 'DEF' ? 'DEF' : posOf(p)}`, style: 'font-size:9px;min-width:26px;height:16px;margin-right:7px' }, posLabel(posOf(p))),
                    h('b', { style: 'cursor:pointer', onclick: () => { S.ui.sel = p.player_id; render(); } }, nameOf(p)),
                    p.is_keeper ? h('span', { class: 'chip amber', style: 'font-size:9px;margin-left:6px' }, 'keeper') : null),
                h('td', { class: 'dim dwho' }, teamOf(p.roster_id)),
                h('td', { class: 'r' }, ptsCell(p.player_id))));
        }
        return h('div', null, head, h('div', { class: 'dscroll' }, tbl));
    }
    // By team: the same picks asked the other question — who drafted well.
    const by = {};
    for (const p of picks) (by[p.roster_id] = by[p.roster_id] || []).push(p);
    const totalOf = (rid) => by[rid].reduce((a, p) => a + (ptsOf(p.player_id) || 0), 0);
    const order = Object.keys(by).map(Number).sort((a, b) => totalOf(b) - totalOf(a));
    const grid = h('div', { class: 'dteams' });
    for (const rid of order) {
        const ps = by[rid].slice().sort((a, b) => a.pick_no - b.pick_no);
        const scored = ps.filter(p => ptsOf(p.player_id) != null);
        const best = scored.length ? scored.reduce((a, b) => (ptsOf(b.player_id) > ptsOf(a.player_id) ? b : a)) : null;
        const mine = S.myRoster && rid === S.myRoster.roster_id;
        const card = h('div', { class: `dcard${mine ? ' me' : ''}` },
            h('div', { class: 'dch' }, h('b', null, teamOf(rid)), h('span', { class: 'dtot mono' }, scored.length ? fmt1(totalOf(rid)) : '—')),
            best ? h('div', { class: 'dcsub' }, 'best pick ', h('b', null, nameOf(best)), ' ', h('span', { class: 'mono' }, fmt1(ptsOf(best.player_id)))) : h('div', { class: 'dcsub' }, 'no points scored yet'));
        const list = h('div', { class: 'dpicks' });
        for (const p of ps) list.append(h('div', { class: 'dp' },
            h('span', { class: 'mono dim dno' }, slot(p)),
            h('span', { class: `pos ${posOf(p) === 'DEF' ? 'DEF' : posOf(p)}`, style: 'font-size:8.5px;min-width:24px;height:15px' }, posLabel(posOf(p))),
            h('span', { class: 'dnm', onclick: () => { S.ui.sel = p.player_id; render(); } }, nameOf(p)),
            ptsCell(p.player_id)));
        card.append(list); grid.append(card);
    }
    return h('div', null, head, h('div', { class: 'dscroll' }, grid));
}
// The League page: what this league IS. The rules you argue about mid-week,
// the whole scoring sheet, and the draft these rosters came out of. Nothing
// here is editable — commissioner screens stay Sleeper's.
function pageLeague() {
    const page = h('div', { class: 'page league' });
    // Three sections. Settings and Scoring are one: Sleeper keeps them apart, but they are one
    // question (what are this league's rules?) and one screen answers it.
    let tab = S.ui.lgTab || 'standings'; if (tab === 'settings' || tab === 'scoring') tab = 'rules';
    const tabs = [['standings', 'Standings'], ['rules', 'Settings & scoring'], ['draft', 'Draft results']];
    let body;
    try {
        body = tab === 'draft' ? lgDraftTab()
            : tab === 'rules' ? h('div', null, h('h3', { class: 'lgsec' }, 'Settings'), lgSettingsTab(), h('h3', { class: 'lgsec' }, 'Scoring'), lgScoringTab())
            : lgStandingsTab();
    } catch (e) { console.error(TAG, 'league tab:', e); body = h('div', { class: 'empty' }, 'That tab hit an error: ' + e.message); }
    page.append(h('div', { class: 'card lgcard' },
        // No heading: the league's name is in the brand bar two lines up. These are the page's own
        // sections, so they are a tab bar (bigger, on a rule, the open one underlined), not the pills
        // that filter inside a section.
        h('div', { class: 'card-h lgtabs' },
            h('div', { class: 'ptabs', role: 'tablist' }, ...tabs.map(([k, t]) => h('button', { class: k === tab ? 'on' : '', type: 'button', role: 'tab', 'aria-selected': String(k === tab), 'data-focus': `lgtab:${k}`, onclick: () => { S.ui.lgTab = k; render(); } }, t))),
            // only the rules can be edited, and only in Sleeper: the standings and a finished draft cannot
            tab === 'rules' ? h('button', { class: 'btn sm s', onclick: () => showOriginalNav(`/leagues/${S.leagueId}/settings`) }, 'Edit in Sleeper') : null),
        body,
        tab === 'rules' ? h('div', { class: 'cap', style: 'margin-top:12px' }, 'Read-only. Commissioner settings, scoring edits and league management stay Sleeper’s screens.') : null));
    return page;
}

// ── chat drawer, player modal ────────────────────────────────────────────────
// ── the message drawer ───────────────────────────────────────────────────────
// One drawer, every conversation: the league chat and the DMs, switched from a
// dropdown on the title so the list costs no permanent height. What Sleeper's
// own clients do and we did not: replies (an ATTACHMENT, not a field), mentions
// (structured in text_map, with a real user_id), flair badges, and reactions
// drawn from Sleeper's own fourteen PNGs rather than Unicode.
const convoId = () => S.ui.convo || 'league';
const convoIsLeague = () => convoId() === 'league';
const convoOf = (id) => (S.dms || []).find(c => String(c.dm_id) === String(id)) || null;
function convoTitle(c) {
    if (!c) return S.league ? S.league.name : 'League chat';
    if (c.title && c.title.trim()) return c.title.trim();
    const them = (c.recent_users || []).filter(u => String(u.user_id) !== String(S.myUserId));
    return them.map(u => u.display_name).filter(Boolean).join(', ') || 'Direct message';
}
function convoIcon(c) {
    const av = (u) => ((u.metadata || {}).avatar || u.avatar) || null;
    const el = (src, fallback) => h('div', { class: 'avatar sm' }, src ? h('img', { src: String(src).startsWith('http') ? src : avatarUrl(src), alt: '' }) : fallback);
    if (!c) return h('span', { class: 'cico' }, el(S.league && S.league.avatar, '\u{1F3C8}'));
    const them = (c.recent_users || []).filter(u => String(u.user_id) !== String(S.myUserId));
    if (!them.length) return h('span', { class: 'cico' }, el(null, initials(convoTitle(c))));
    return h('span', { class: 'cico' }, ...them.slice(0, 3).map(u => el(av(u), initials(u.display_name || '?'))));
}
function chatMessages() {
    const list = chatList(convoId());
    if (!list) return null;   // null = not fetched yet
    return list;   // roster moves and name changes are back: people react and reply to them. They fold instead (quietRuns).
}
// A DM's trade offer: transactions_by_roster arrives as a JSON STRING here,
// where the league chat sends it already parsed.
function tradeFromAtt(att) {
    if (!att || att.type !== 'trade_dm' || !att.data) return null;
    let by = att.data.transactions_by_roster;
    try { if (typeof by === 'string') by = JSON.parse(by); } catch (e) { return null; }
    if (!by || typeof by !== 'object') return null;
    return { by, status: att.data.status || 'proposed', txnId: att.data.transaction_id, leagueId: att.data.league_id };
}
// What became of an offer: the league's transactions, not the attachment.
function tradeNow(t) {
    const here = t.leagueId && String(t.leagueId) === String(S.leagueId);
    const past = !here && (S.chain || []).find(c => String(c.id) === String(t.leagueId));
    const known = here || !!past;
    if (known && !S.txnStatus[t.leagueId]) loadTradeStatuses(t.leagueId).then(render);
    const map = S.txnStatus[t.leagueId];
    const rec = map && map !== 'busy' ? map[String(t.txnId)] : null;
    let status = null;
    if (rec) {
        const exp = rec.settings && rec.settings.expires_at && rec.settings.expires_at < Date.now() / 1000;
        status = rec.status === 'complete' ? 'accepted' : rec.status === 'failed' ? 'rejected' : rec.status === 'cancelled' ? 'withdrawn' : (rec.status === 'proposed' || rec.status === 'pending') ? (exp ? 'expired' : 'open') : rec.status;
    } else if (map && map !== 'busy') status = 'closed';   // the league no longer lists it: withdrawn, or cleared with its season
    return { here, past, known, status, checking: known && (!map || map === 'busy') };
}
function tradeCard(t) {
    const side = (rid) => {
        const s = t.by[rid] || {};
        const R = t.leagueId && String(t.leagueId) === String(S.leagueId) ? rosterById(rid) : null;
        const who = R ? teamName(R) : ((s.user || {}).display_name || `Roster ${rid}`);
        const players = (s.adds || []).filter(p => p && p.player_id);
        const picks = (s.added_picks || []).map(pk => `${pk.season} R${pk.round}`);
        const budget = (s.added_budget || []).map(b => `$${b.amount} FAAB`);
        if (!players.length && !picks.length && !budget.length) return null;
        return h('div', null,
            h('div', { class: 'tside' }, h('b', null, who), ' gets'),
            ...players.map(p => playerMiniCard(p.player_id, 'trade', p)),
            (picks.length || budget.length) ? h('div', { class: 'tpicks' }, h('span', { class: 'tarr' }, '⇄ '), [...picks, ...budget].join(' · ')) : null);
    };
    const n = tradeNow(t);
    const label = n.checking ? 'checking' : (n.status || (n.known ? 'closed' : 'unknown'));
    const words = { withdrawn: 'withdrawn', open: 'open', accepted: 'accepted', rejected: 'rejected', expired: 'expired', closed: 'no longer open', checking: 'checking…', unknown: 'status unknown' };
    const open = n.status === 'open';
    return h('div', { class: 'tradec' },
        h('div', { class: 'th' }, h('span', null, '⇄ Trade'), n.past ? h('span', { class: 'tseason' }, `${n.past.season} season`) : null,
            h('span', { class: `tstat ${label}` }, words[label] || label)),
        ...Object.keys(t.by).map(side).filter(Boolean),
        open && n.here ? h('div', { class: 'tacts' },
            h('button', { class: 'btn sm p', onclick: () => openTx({ tab: 'trades' }) }, 'Review →'),
            h('span', { class: 'dim', style: 'font-size:11px;align-self:center' }, 'accept or reject in Transactions')) : null,
        !n.known ? h('div', { class: 'cap' }, 'From a league this page is not showing.') : null);
}
// Sleeper's fourteen reactions, named in words beside the art.
const EMOJI_WORD = { like: 'Like', happy: 'Haha', facepalm: 'Facepalm', sad: 'Sad', shock: 'Shock', thinking: 'Thinking', heart: 'Love', fire: 'Fire', poop: 'Poop', eyes: 'Eyes', angry: 'Angry', clown: 'Clown', goat: 'GOAT', smart: 'Smart' };
const myReactions = (m) => (Array.isArray(m.user_reactions) ? m.user_reactions : []).map(x => typeof x === 'string' ? x : x && x.reaction).filter(Boolean);
// A GIF or photo: Sleeper's attachment carries the CDN address and nothing to read.
function mediaOf(att) {
    if (!att || Array.isArray(att) || !att.data) return null;
    if (!/^(gif|giphy|photo|image)$/.test(att.type || '')) return null;
    const d = att.data;
    // url is a tiny placeholder frame (17×10 on the one this league has); url_original is the GIF
    const src = d.url_original || (d.images && d.images.original && d.images.original.url) || d.url || null;
    if (!src || !/^https:\/\//.test(String(src))) return null;
    return { src: String(src), full: String(d.url_original || src), kind: att.type };
}
const chatClock = (ms) => { const d = new Date(ms), hr = d.getHours() % 12 || 12; return `${hr}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'a' : 'p'}`; };
function chatDrawer() {
    const cid = convoId(), conv = convoIsLeague() ? null : convoOf(cid);
    const parentId = chatParent(cid);
    if (S.dms == null && !S.dmBusy) { S.dmBusy = true; loadDms().then(() => { S.dmBusy = false; render(); }).catch(() => { S.dmBusy = false; }); }
    if (!chatList(cid) && !S.dmMsgs['busy:' + cid]) {
        S.dmMsgs['busy:' + cid] = true;
        loadConvo(cid).then(() => { delete S.dmMsgs['busy:' + cid]; render(); }).catch(() => { delete S.dmMsgs['busy:' + cid]; });
    }
    S.ui.drafts = S.ui.drafts || {};
    // Where this conversation stood when you opened it: the NEW line sits under
    // your old read line, and stays put while you read even after it is marked.
    if (!S.ui.chatView || S.ui.chatView.cid !== cid) {
        const readAt = convoIsLeague() ? S.chatRead.league : ((conv && conv.last_read_id) || S.chatRead[cid]);
        S.ui.chatView = { cid, anchor: readAt || null, atBottom: true, fresh: true, seen: null };
    }
    const V = S.ui.chatView;

    const body = h('div', { class: 'db', 'data-keep': `chat-${cid}`, role: 'log', 'aria-live': 'polite' });
    const msgs = chatMessages();
    const isSys = isBotMsg;
    const deent = (s) => String(s || '').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const SPAM = /^Commissioner has updated the schedule/;
    const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
    const dayLabel = (ms) => {
        const d2 = new Date(ms), now = new Date();
        const k = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d2.getFullYear(), d2.getMonth(), d2.getDate())) / 86400000);
        if (k <= 0) return 'TODAY';
        if (k === 1) return 'YESTERDAY';
        const opts = d2.getFullYear() === now.getFullYear() ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
        return d2.toLocaleDateString('en-US', opts).toUpperCase();
    };
    const isMe = (m) => String(m.author_id) === String(S.myUserId);
    // The divider already says the day, so the stamp says the time; the hour-old
    // and newer keep "12m". Hover for the whole date.
    const stamp = (m) => {
        const full = new Date(m.created).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        return h('span', { class: 'w', title: `${full} (${ago(m.created)} ago)` }, Date.now() - m.created < 3600000 ? ago(m.created) : chatClock(m.created));
    };
    const sysIcon = () => h('span', { class: 'sic' }, h('img', { src: 'https://sleeper.com/favicon.ico', alt: '', onerror: (e) => { e.target.parentElement.textContent = '\u{1F6E1}️'; } }));
    const chatAvatar = (av) => av ? h('span', { class: 'sic' }, h('img', { src: String(av).startsWith('http') ? av : avatarUrl(av), alt: '', onerror: (e) => { e.target.parentElement.textContent = '\u{1F6E1}️'; } })) : null;

    // ── the text: mentions and flair ─────────────────────────────────────────
    // text_map keys the mention by its "@Name" token and hands back the real
    // user_id, so "is this me" is an id comparison rather than a name match.
    const textEl = (m, override) => {
        const raw = override != null ? override : deent(m.text || '');
        const map = m.text_map || {};
        const out = [];
        let last = 0;
        const re = /<@([^>]+)>/g;
        let mm;
        while ((mm = re.exec(raw))) {
            if (mm.index > last) out.push(raw.slice(last, mm.index));
            const name = mm[1];
            const ent = map['@' + name];
            const uid = ent && ent.data && ent.data.user_id;
            const me = uid && String(uid) === String(S.myUserId);
            out.push(h('span', { class: `mchip ${me ? 'me' : ''}`.trim(), title: me ? 'You were mentioned' : name }, '@' + name));
            last = mm.index + mm[0].length;
        }
        if (last < raw.length) out.push(raw.slice(last));
        const bolded = [];
        for (const part of (out.length ? out : [raw])) {
            if (typeof part !== 'string' || part.indexOf('**') < 0) { bolded.push(part); continue; }
            part.split(/(\*\*[^*\n]+\*\*)/).forEach(seg => { const b = /^\*\*([^*\n]+)\*\*$/.exec(seg); bolded.push(b ? h('b', null, b[1]) : seg); });
        }
        return bolded;
    };
    const plain = (t) => deent(t || '').replace(/<@([^>]+)>/g, '@$1').replace(/\*\*([^*\n]+)\*\*/g, '$1');
    const mentionsMe = (m) => {
        const map = m.text_map || {};
        for (const k in map) { const e = map[k]; if (e && e.type === 'mention' && e.data && String(e.data.user_id) === String(S.myUserId)) return true; }
        return false;
    };
    const flairEls = (m) => {
        const f = (m.text_map || {}).flairs;
        const list = f && Array.isArray(f.data) ? f.data : [];
        return list.filter(x => x && x.subject_id).slice(0, 4).map(x => h('span', { class: 'flair', title: `${x.subject_id} fan` }, x.subject_id));
    };
    // ── the quoted reply ─────────────────────────────────────────────────────
    const replyEl = (m) => {
        const a = m.attachment;
        if (!a || Array.isArray(a) || a.type !== 'reply' || !a.data) return null;
        const d = a.data;
        return h('div', { class: 'quote', title: 'Jump to the message this answers', role: 'button', tabindex: '0', onclick: () => jumpToMsg(d.messageId), onkeydown: (e) => { if (e.key === 'Enter') jumpToMsg(d.messageId); } },
            h('span', { class: 'qa' }, '↩ ', d.displayName || 'someone'),
            h('span', { class: 'qt' }, plain(d.text)));
    };
    const jumpToMsg = (id) => {
        const el = body.querySelector(`[data-mid="${id}"]`);
        if (!el) { toast(S.chatOlder[cid] === 'done' ? 'That message is no longer in the conversation' : 'That message is further back: scroll up to load older messages'); return; }
        V.atBottom = false;
        el.scrollIntoView({ block: 'center' });
        el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200);
    };
    // ── reactions ────────────────────────────────────────────────────────────
    // reactions is a count per name; user_reactions lists only yours, as objects.
    const rxCount = (v) => Array.isArray(v) ? v.length : (typeof v === 'number' ? v : (v && typeof v === 'object' ? Object.keys(v).length : 0));
    const toggleReaction = async (m, name) => {
        const mine = myReactions(m), on = mine.includes(name);
        try {
            await reactTo(m, parentId, name, on);
            m.reactions = Object.assign({}, m.reactions, { [name]: Math.max(0, rxCount((m.reactions || {})[name]) + (on ? -1 : 1)) });
            m.user_reactions = on ? (m.user_reactions || []).filter(x => (typeof x === 'string' ? x : x && x.reaction) !== name) : [...(Array.isArray(m.user_reactions) ? m.user_reactions : []), { reaction: name, reactor_id: String(S.myUserId) }];
            render();
        } catch (e) { toast(e.message, 'err'); }
    };
    const reactBar = (m) => {
        const rx = m.reactions || {};
        const mine = myReactions(m);
        const names = Object.keys(rx).filter(n => rxCount(rx[n]) > 0);
        const row = names.length ? h('div', { class: 'rx' }) : null;
        if (row) {
            for (const n of names) {
                const c = rxCount(rx[n]), on = mine.includes(n);
                const who = on ? (c <= 1 ? 'You' : `You and ${c - 1} other${c > 2 ? 's' : ''}`) : `${c} ${c === 1 ? 'person' : 'people'}`;
                row.append(h('button', { class: on ? 'mine' : '', title: `${EMOJI_WORD[n] || n}: ${who}${on ? ' (click to remove yours)' : ''}`, 'aria-label': `${EMOJI_WORD[n] || n}, ${who}`, onclick: () => toggleReaction(m, n) }, emojiEl(n), ' ', String(c)));
            }
        }
        const picker = S.ui.rxPick === m.message_id
            ? h('div', { class: 'rxpick', role: 'menu' }, ...SLEEPER_EMOJI.map(n => h('button', { class: `rxw ${mine.includes(n) ? 'mine' : ''}`.trim(), title: mine.includes(n) ? `Remove ${EMOJI_WORD[n]}` : EMOJI_WORD[n], onclick: () => { S.ui.rxPick = null; toggleReaction(m, n); } }, emojiEl(n), h('span', null, EMOJI_WORD[n] || n))))
            : null;
        return [row, picker];
    };
    // ── the action bar: on hover, and on keyboard focus ──────────────────────
    const actions = (m) => {
        const mine = myReactions(m);
        const del = isMe(m) && m.message_id;
        const asking = S.ui.delAsk === m.message_id;
        return h('div', { class: 'mbar' },
            ...['like', 'happy', 'fire', 'goat'].map(n => h('button', { class: `rxb ${mine.includes(n) ? 'mine' : ''}`.trim(), title: mine.includes(n) ? `Remove ${EMOJI_WORD[n]}` : EMOJI_WORD[n], 'aria-label': EMOJI_WORD[n], onclick: () => toggleReaction(m, n) }, emojiEl(n))),
            h('button', { class: 'mb', title: 'All reactions', onclick: () => { S.ui.rxPick = S.ui.rxPick === m.message_id ? null : m.message_id; V.atBottom = false; render(); setTimeout(() => { const pk = $('.drawer .rxpick'); if (pk) pk.scrollIntoView({ block: 'nearest' }); }, 0); } }, 'MORE'),
            h('button', { class: 'mb', title: 'Reply', onclick: () => { S.ui.replyTo = m; render(); setTimeout(() => { const el = $('[data-focus="chat-composer"]'); if (el) el.focus(); }, 0); } }, 'REPLY'),
            del ? h('button', { class: `mb ${asking ? 'danger' : ''}`.trim(), title: asking ? 'Click again to delete for everyone' : 'Delete your message',
                onclick: async () => {
                    if (!asking) { S.ui.delAsk = m.message_id; render(); setTimeout(() => { if (S.ui.delAsk === m.message_id) { S.ui.delAsk = null; render(); } }, 4000); return; }
                    S.ui.delAsk = null;
                    try { await deleteMessage(cid, m); render(); toast('Message deleted', 'ok'); } catch (e) { toast(`Not deleted: ${e.message}`, 'err'); }
                } }, asking ? 'DELETE?' : 'DELETE') : null);
    };

    const pcardEl = (p, kind) => playerMiniCard(p.player_id, kind, p);
    const attCards = (att) => {
        try {
            if (!att || Array.isArray(att)) return null;
            const trade = tradeFromAtt(att);
            if (trade) return [tradeCard(trade)];
            if (Array.isArray(att.data)) {
                const out = [];
                for (const txn of att.data) {
                    const byR = txn && txn.transactions_by_roster; if (!byR) continue;
                    const rids = Object.keys(byR);
                    const sideName = (rid) => { const R = rosterById(rid); return R ? teamName(R) : ((byR[rid].user || {}).display_name || `Roster ${rid}`); };
                    const isTrade = rids.length > 1 || rids.some(rid => (byR[rid].added_picks || []).length || (byR[rid].added_budget || []).length);
                    for (const rid of rids) {
                        const s2 = byR[rid];
                        const adds = (s2.adds || []).filter(p => p && p.player_id);
                        const drops = (s2.drops || []).filter(p => p && p.player_id);
                        const picks = (s2.added_picks || []).map(pk => `${pk.season} R${pk.round}`);
                        const budget = (s2.added_budget || []).map(b => `$${b.amount} FAAB`);
                        if (isTrade) {
                            if (!adds.length && !picks.length && !budget.length) continue;
                            out.push(h('div', { class: 'tside' }, h('b', null, sideName(rid)), ' gets'));
                            for (const p of adds) out.push(pcardEl(p, 'trade'));
                            if (picks.length || budget.length) out.push(h('div', { class: 'tpicks' }, h('span', { class: 'tarr' }, '⇄ '), [...picks, ...budget].join(' · ')));
                        } else {
                            for (const p of adds) out.push(pcardEl(p, 'add'));
                            for (const p of drops) out.push(pcardEl(p, 'drop'));
                        }
                    }
                }
                return out.length ? out : null;
            }
            const d = att.data;
            if (d && d.player_id && d.position) return [pcardEl(d, 'block')];
        } catch (e) { /* fall through to text */ }
        return null;
    };
    const mediaEl = (m) => {
        const md = mediaOf(m.attachment); if (!md) return null;
        return h('a', { class: 'chmedia', href: md.full, target: '_blank', rel: 'noopener noreferrer', title: 'Open full size' },
            h('img', { src: md.src, alt: md.kind === 'photo' || md.kind === 'image' ? `Photo from ${m.author_display_name || 'someone'}` : `GIF from ${m.author_display_name || 'someone'}`, loading: 'lazy',
                onerror: (e) => { const a = e.target.parentElement; if (a) a.replaceWith(h('span', { class: 'chtxt' }, 'A GIF that no longer loads')); } }));
    };
    const rxTotal = (x) => Object.values(x.reactions || {}).reduce((t, v) => t + rxCount(v), 0);
    const repliedTo = new Set((msgs || []).map(x => { const a = x.attachment; return a && !Array.isArray(a) && a.type === 'reply' && a.data ? String(a.data.messageId) : null; }).filter(Boolean));
    const POS_PLURAL = { K: 'kickers', DEF: 'defenses', QB: 'quarterbacks', RB: 'running backs', WR: 'receivers', TE: 'tight ends' };
    const userAv = (u) => { const src = u && (((u.metadata || {}).avatar) || (u.avatar ? avatarUrl(u.avatar) : null)); return h('div', { class: 'avatar sm' }, src ? h('img', { src: String(src), alt: '' }) : initials((u && u.display_name) || '?')); };
    // ADD and DROP are words, not only green and red: the pair is the one
    // colour-blind readers cannot tell apart.
    // ── roster moves as cards (M2) ───────────────────────────────────────────
    // Each move is a small card: who and what in the header, then every player
    // on his own line — ADD, then DROP — with his headshot. Never side by side: a
    // 360px drawer has no room for two columns of names. ADD and DROP are words,
    // so direction never rests on green and red.
    const mvName = (p) => { const pid = String(p.player_id || ''), pos = p.position || ppos(pid);
        return pos === 'DEF' ? `${pid} D/ST` : (p.first_name && p.last_name ? `${p.first_name[0]}. ${p.last_name}` : pname(pid)); };
    const mvPlayer = (p, dir) => {
        const pid = String(p.player_id || ''), pos = p.position || ppos(pid);
        return h('button', { class: `mvp2 ${dir}`, title: `${dir === 'in' ? 'Added' : 'Dropped'} ${`${p.first_name || ''} ${p.last_name || ''}`.trim() || pname(pid)}${p.team ? ` (${p.team})` : ''}`, onclick: (e) => { e.stopPropagation(); if (pid) { S.ui.sel = pid; render(); } } },
            h('img', { class: 'mvhs', src: headshot(pid), alt: '', loading: 'lazy', onerror: hideBroken }),
            h('span', { class: 'mvlab' }, dir === 'in' ? 'ADD' : 'DROP'),   // never "OUT": that is an injury designation
            h('span', { class: 'mvnm' }, mvName(p)),
            pos && pos !== 'DEF' ? h('span', { class: `pos txt ${pos}` }, posLabel(pos)) : null);   // "KC D/ST" already says it
    };
    const mvCard = (o) => h('div', { class: 'mvcard' },
        h('div', { class: 'mvch' }, h('b', { class: o.mine ? 'cme' : '' }, o.who), o.mine ? h('span', { class: 'dim' }, '(you)') : null,
            o.kind ? h('span', { class: 'mvkind' }, ...[].concat(o.kind)) : null, o.time || null),
        ...o.ins.map(p => mvPlayer(p, 'in')), ...o.outs.map(p => mvPlayer(p, 'out')),
        o.foot ? h('div', { class: 'mvfoot' }, ...o.foot) : null);
    const isMineR = (R) => !!S.myRoster && !!R && R.roster_id === S.myRoster.roster_id;
    const whoOf = (R, user, rid) => (user && user.display_name) || (R ? teamName(R) : `Team ${rid}`);
    const money = (b) => b != null && waiverInfo().faab ? `$${b}` : null;
    const KIND = { free_agent: 'FREE AGENT', waiver: 'WAIVER', commissioner: 'COMMISSIONER', trade: 'TRADE' };
    // A waiver run is one message holding every claim in it: each winner, and
    // each losing bid by another owner, marked complete or failed. A card per
    // winning claim; the bids that lost ride in the foot of the card they chased.
    const isWaiverRun = (m) => { const a = m.attachment; return a && a.type === 'transactions' && Array.isArray(a.data) && a.data.length > 0 && a.data.every(t => t && t.type === 'waiver'); };
    const waiverRow = (m) => {
        const claims = [];
        for (const txn of m.attachment.data) for (const rid of Object.keys((txn && txn.transactions_by_roster) || {})) {
            const s2 = txn.transactions_by_roster[rid] || {}, st2 = s2.settings || {};
            claims.push({ rid, R: rosterById(rid), user: s2.user || {}, won: s2.status === 'complete', bid: st2.waiver_bid, seq: st2.seq ?? 99,
                adds: (s2.adds || []).filter(x => x && x.player_id), drops: (s2.drops || []).filter(x => x && x.player_id) });
        }
        const winners = claims.filter(c => c.won).sort((a2, b2) => a2.seq - b2.seq);
        const lost = claims.filter(c => !c.won).sort((a2, b2) => a2.seq - b2.seq);
        const lostOn = (pid) => lost.filter(c => c.adds.some(x => String(x.player_id) === String(pid)));
        const shown = new Set();
        const bidTxt = (c) => [h('b', { class: isMineR(c.R) ? 'cme' : '' }, isMineR(c.R) ? 'you' : whoOf(c.R, c.user, c.rid)), money(c.bid) ? ` ${money(c.bid)}` : null];
        const one = winners.length === 1;
        const cards = winners.map(c => {
            const out = c.adds.flatMap(x => lostOn(x.player_id)); out.forEach(x => shown.add(x));
            return mvCard({ who: whoOf(c.R, c.user, c.rid), mine: isMineR(c.R), kind: ['WAIVER', money(c.bid) ? h('span', { class: 'mvbid' }, ` · ${money(c.bid)}`) : null], time: one ? stamp(m) : null,
                ins: c.adds, outs: c.drops, foot: out.length ? ['Outbid: ', ...out.flatMap((x, k) => [k ? ' · ' : null, ...bidTxt(x)])] : null });
        });
        const orphans = lost.filter(c => !shown.has(c)).map(c => h('div', { class: 'mvorphan' }, ...bidTxt(c), ' bid on ',
            ...c.adds.map(x => h('b', null, mvName(x))), ' — not claimed'));
        // a long run shows three cards; the rest open on a press
        const key = `wv${m.message_id}`, open = S.ui.chatFolds && S.ui.chatFolds.has(key), CAP = 3;
        const shownCards = open || cards.length <= CAP + 1 ? cards : cards.slice(0, CAP);
        const more = cards.length > shownCards.length ? h('button', { class: 'mvmore', onclick: (e) => { e.stopPropagation(); S.ui.chatFolds = S.ui.chatFolds || new Set(); S.ui.chatFolds.add(key); render(); } }, `Show ${cards.length - shownCards.length} more claims`) : null;
        const head = one ? null : h('div', { class: 'mvrunh' }, h('b', null, 'Waivers'), ` · ${winners.length} claim${winners.length === 1 ? '' : 's'} processed${lost.length ? `, ${lost.length} outbid` : ''}`, stamp(m));
        const face = one && winners[0].R ? avatarEl(winners[0].R, 'sm') : sysIcon();
        return h('div', { class: 'move mline mvrow', 'data-mid': m.message_id, tabindex: '0', 'aria-label': plain(m.text) },
            face, h('div', { class: 'gbody' }, head, ...shownCards, more, ...(open || !more ? orphans : []), ...reactBar(m).filter(Boolean)), actions(m));
    };
    const moveRow = (m) => {
        const cards = []; let face = null;
        for (const txn of m.attachment.data) for (const rid of Object.keys((txn && txn.transactions_by_roster) || {})) {
            const s2 = txn.transactions_by_roster[rid] || {}, R = rosterById(rid);
            const ins = (s2.adds || []).filter(x => x && x.player_id), outs = (s2.drops || []).filter(x => x && x.player_id);
            if (!ins.length && !outs.length) continue;
            if (!face) face = R ? avatarEl(R, 'sm') : userAv(s2.user);
            const bid = s2.settings && s2.settings.waiver_bid;
            const kind = KIND[txn.type] || 'ROSTER MOVE';   // the row already says ADD or DROP; the header says what kind of move
            cards.push(mvCard({ who: whoOf(R, s2.user, rid), mine: isMineR(R), kind: [kind, txn.type === 'waiver' && money(bid) ? h('span', { class: 'mvbid' }, ` · ${money(bid)}`) : null], time: cards.length ? null : stamp(m), ins, outs }));
        }
        if (!cards.length) return null;
        return h('div', { class: 'move mline mvrow', 'data-mid': m.message_id, tabindex: '0', 'aria-label': plain(m.text) },
            face || sysIcon(), h('div', { class: 'gbody' }, ...cards, ...reactBar(m).filter(Boolean)), actions(m));
    };
    const quietRow = (m) => {
        if (isWaiverRun(m)) return waiverRow(m);
        const a = m.attachment, d = a.data;
        if (a.type === 'transactions') { const r = moveRow(m); if (r) return r; }
        let face = null, who = '', what = [];
        if (a.type === 'player_nickname_update') {
            face = userAv(d.user); who = (d.user && d.user.display_name) || '';
            const ch = d.changes || [];
            ch.forEach((c, k) => { const pl = c.player || {}; what.push(h('span', null, k === 0 ? ' renamed ' : k === ch.length - 1 ? ' and ' : ', ', h('button', { class: 'mvname', onclick: (e) => { e.stopPropagation(); if (pl.player_id) { S.ui.sel = String(pl.player_id); render(); } } }, `${pl.first_name || ''} ${pl.last_name || ''}`.trim()), ' ', c.nickname ? h('span', { class: 'nick' }, `\u201c${deent(c.nickname)}\u201d`) : 'back to his name')); });
        } else if (a.type === 'team_name_update') {
            face = userAv(d.user); who = (d.user && d.user.display_name) || '';
            what.push(h('span', null, ' renamed their team ', h('span', { class: 'nick' }, `\u201c${deent(String(d.team_name || '').trim())}\u201d`)));
        }
        if (!what.length) what.push(h('span', null, ' ', deent(m.text || '')));
        return h('div', { class: 'move mline', 'data-mid': m.message_id, tabindex: '0', 'aria-label': plain(m.text) },
            face || sysIcon(),
            h('div', { class: 'gbody' }, h('div', { class: 'mvtxt' }, h('b', null, who), ' ', ...what, ' ', stamp(m)), ...reactBar(m).filter(Boolean)),
            actions(m));
    };
    const quietFold = (run, kind, open, toggle) => {
        const faces = [], seen = new Set();
        for (const x of run) {
            const a = x.attachment; let key = null, el = null;
            if (a.type === 'transactions') { for (const txn of a.data) for (const rid of Object.keys((txn && txn.transactions_by_roster) || {})) if (!key) { key = `r${rid}`; const R = rosterById(rid); el = R ? avatarEl(R, 'xs') : null; } }
            else if (a.data && a.data.user) { key = `u${a.data.user.display_name}`; const u = a.data.user, src = (u.metadata || {}).avatar || (u.avatar ? avatarUrl(u.avatar) : null); el = h('div', { class: 'avatar xs' }, src ? h('img', { src: String(src), alt: '' }) : initials(u.display_name)); }
            if (key && el && !seen.has(key) && faces.length < 4) { seen.add(key); faces.push(el); }
        }
        let label;
        if (kind === 'move') {
            const pos = new Set(); for (const x of run) for (const txn of x.attachment.data) for (const rid of Object.keys((txn && txn.transactions_by_roster) || {})) for (const p of txn.transactions_by_roster[rid].adds || []) if (p && p.position) pos.add(p.position);
            label = [h('b', null, `${run.length} roster moves`), pos.size === 1 && POS_PLURAL[[...pos][0]] ? ` \u00b7 ${POS_PLURAL[[...pos][0]]}` : null];
        } else {
            const nick = run.filter(x => attType(x) === 'player_nickname_update').length, team = run.length - nick;
            label = [h('b', null, !team ? `${nick} nickname changes` : !nick ? `${team} team names changed` : `${run.length} name changes`)];
        }
        return h('button', { class: `qfold ${open ? 'open' : ''}`.trim(), 'aria-expanded': open ? 'true' : 'false', onclick: toggle },
            h('span', { class: 'qstack' }, ...faces), h('span', { class: 'qlab' }, ...label), h('span', { class: 'qshow' }, open ? 'HIDE' : 'SHOW'));
    };
    // One message's line: its own action bar, so a reply or reaction can land
    // on the third message of a group, not only the first.
    const line = (m, first) => {
        const text = (m.text || '').trim();
        const media = mediaEl(m);
        return h('div', { class: `mline ${first ? 'first' : ''}`.trim(), 'data-mid': m.message_id, tabindex: '0', 'aria-label': `${m.author_display_name || 'Someone'}: ${plain(m.text).slice(0, 80) || 'a GIF'}` },
            replyEl(m),
            text ? h('div', { class: 't' }, ...textEl(m)) : (media ? null : h('div', { class: 't dim' }, 'sent something this page cannot show')),
            media,
            ...reactBar(m).filter(Boolean),
            actions(m));
    };

    if (msgs == null) body.append(h('div', { class: 'cap' }, h('span', { class: 'spin' }), ' Reading the conversation…'));
    else {
        // the top of the list: older history, or the start of the conversation
        const older = S.chatOlder[cid];
        if (msgs.length) body.append(older === 'done' ? h('div', { class: 'day start' }, 'START OF THE CONVERSATION')
            : h('button', { class: 'olderbtn', disabled: older === 'busy', onclick: () => chatLoadOlder() }, older === 'busy' ? 'Loading older messages…' : 'Load older messages'));
        let lastDay = null, lastAuthor = null, lastAt = 0, lastGroup = null, i = 0, newDone = false;
        while (i < msgs.length) {
            const m = msgs[i];
            // the NEW line: above the first message from someone else after your read line
            if (!newDone && V.anchor && idGt(m.message_id, V.anchor) && !isMe(m) && !isSys(m)) {
                body.append(h('div', { class: 'newline', role: 'separator' }, h('span', null, 'NEW')));
                newDone = true; lastGroup = null;
            }
            const dk = dayKey(m.created);
            if (dk !== lastDay) { body.append(h('div', { class: 'day' }, dayLabel(m.created))); lastDay = dk; lastGroup = null; }
            if (isSys(m) && SPAM.test(m.text || '')) {
                let j = i; while (j < msgs.length && isSys(msgs[j]) && SPAM.test(msgs[j].text || '') && dayKey(msgs[j].created) === dk) j++;
                if (j - i >= 3) {
                    const key = String(m.message_id || m.created);
                    const open = S.ui.chatFolds && S.ui.chatFolds.has(key);
                    if (open) for (let x = i; x < j; x++) body.append(h('div', { class: 'sysrow' }, sysIcon(), h('div', { class: 'sbody' }, h('div', { class: 'chtxt' }, deent(msgs[x].text), stamp(msgs[x])))));
                    body.append(h('button', { class: 'fold', onclick: () => { S.ui.chatFolds = S.ui.chatFolds || new Set(); if (open) S.ui.chatFolds.delete(key); else S.ui.chatFolds.add(key); render(); } }, open ? `Hide ${j - i} schedule updates` : `${j - i} schedule updates from Sleeper: show`));
                    i = j; lastGroup = null; continue;
                }
            }
            // Roster moves and name changes: a row each, and a run of them inside the
            // hour folds to one line. A row someone reacted to or replied to always shows.
            const qk = quietKind(m);
            if (qk) {
                const sticky = (x) => rxTotal(x) > 0 || repliedTo.has(String(x.message_id));
                let j = i + 1;
                if (!sticky(m)) while (j < msgs.length && quietKind(msgs[j]) === qk && !sticky(msgs[j]) && dayKey(msgs[j].created) === dk && msgs[j].created - msgs[j - 1].created < 3600000) j++;
                const run = msgs.slice(i, j);
                if (run.length >= 2) {
                    const key = `q${run[0].message_id}`;
                    const open = S.ui.chatFolds && S.ui.chatFolds.has(key);
                    body.append(quietFold(run, qk, open, () => { S.ui.chatFolds = S.ui.chatFolds || new Set(); if (open) S.ui.chatFolds.delete(key); else S.ui.chatFolds.add(key); render(); }));
                    if (open) for (const x of run) body.append(quietRow(x));
                } else body.append(quietRow(m));
                lastGroup = null; i = j; continue;
            }
            const cards = attType(m) === 'league_report' && m.attachment.data ? [reportCard(m.attachment.data)] : attCards(m.attachment);
            const quote = replyEl(m);
            if (isSys(m) || cards) {
                const full = deent(m.text);
                const txt = cards && attType(m) !== 'league_report' ? (full.split(':')[0] || full) : full;
                body.append(h('div', { class: 'sysrow mline', 'data-mid': m.message_id, tabindex: '0' }, actorIcon2(m, deent, chatAvatar) || sysIcon(),
                    h('div', { class: 'sbody' }, quote, h('div', { class: 'chtxt' }, ...textEl(m, txt), stamp(m)), ...(cards || []), ...reactBar(m).filter(Boolean)), actions(m)));
                lastGroup = null; i++; continue;
            }
            // A reply always starts its own block: it is answering something,
            // so folding it into the previous message would lose the thread.
            const grouped = lastGroup && !quote && String(m.author_id) === String(lastAuthor) && m.created - lastAt < 5 * 60000;
            if (grouped) lastGroup.append(line(m, false));
            else {
                const u = S.users.find(x => String(x.user_id) === String(m.author_id));
                const tn = u && u.metadata && u.metadata.team_name && u.metadata.team_name.trim();
                const gbody = h('div', { class: 'gbody' },
                    h('div', { class: 'ghdr' }, h('b', { class: isMe(m) ? 'cme' : '' }, m.author_display_name), ...flairEls(m), tn ? h('span', { class: 'gtm' }, tn) : null, stamp(m)),
                    line(m, true));
                body.append(h('div', { class: `grp ${mentionsMe(m) ? 'lit' : ''}`.trim() },
                    h('div', { class: 'avatar sm' }, m.author_avatar ? h('img', { src: avatarUrl(m.author_avatar), alt: '' }) : initials(m.author_display_name)),
                    gbody));
                lastGroup = gbody;
            }
            lastAuthor = m.author_id; lastAt = m.created; i++;
        }
        // yours, on its way
        for (const pm of S.chatPending[cid] || []) {
            body.append(h('div', { class: 'grp pend' },
                h('div', { class: 'avatar sm' }, initials((S.users.find(x => String(x.user_id) === String(S.myUserId)) || {}).display_name || 'Me')),
                h('div', { class: 'gbody' }, h('div', { class: 'ghdr' }, h('b', { class: 'cme' }, 'You'), h('span', { class: 'w' }, 'sending…')),
                    pm.replyTo ? h('div', { class: 'quote' }, h('span', { class: 'qa' }, '↩ ', pm.replyTo.author_display_name || 'someone'), h('span', { class: 'qt' }, plain(pm.replyTo.text))) : null,
                    h('div', { class: 't' }, pm.text))));
        }
        if (!msgs.length && !(S.chatPending[cid] || []).length) body.append(h('div', { class: 'empty' }, convoIsLeague() ? 'No messages yet.' : 'Nothing said yet.'));
    }
    const chatLoadOlder = () => {
        if (S.chatOlder[cid]) return;
        V.prevHeight = body.scrollHeight; V.prevTop = body.scrollTop; V.atBottom = false;
        const p = loadOlder(cid); render(); p.then(() => { V.restore = true; render(); });
    };
    body.addEventListener('scroll', () => {
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
        if (atBottom !== V.atBottom) {
            V.atBottom = atBottom;
            if (atBottom) { const pill = $('.jumpnew'); if (pill) pill.remove(); markNewest(); }
        }
        if (body.scrollTop < 40 && msgs && msgs.length && !S.chatOlder[cid] && body.scrollHeight > body.clientHeight + 40) chatLoadOlder();
    }, { passive: true });
    const unseenNow = () => !!$('.jumpnew');
    const markNewest = () => {
        if (document.hidden) return;
        const list = chatList(cid) || [];
        const last = list.length ? list[list.length - 1] : null;
        if (!last) return;
        V.seen = String(last.message_id);
        const cur = convoIsLeague() ? S.chatRead.league : ((conv && conv.last_read_id) || S.chatRead[cid]);
        if (cur && !idGt(last.message_id, cur)) { if (unseenNow()) render(); return; }
        markRead(cid, last.message_id);
        render();   // the counts move; the next pass finds nothing newer and stops
    };

    // ── the switcher ─────────────────────────────────────────────────────────
    const nDm = unreadDms(), nLg = leagueUnread();
    const switchTo = (id) => (e) => { e.stopPropagation(); S.ui.convo = id; S.ui.convoOpen = false; S.ui.replyTo = null; S.ui.mentionQ = null; S.ui.rxPick = null; render(); };
    const convRow = (c) => {
        const on = !convoIsLeague() && String(cid) === String(c.dm_id);
        return h('button', { class: `conv ${on ? 'on' : ''}`.trim(), onclick: switchTo(String(c.dm_id)) },
            convoIcon(c),
            h('div', { style: 'min-width:0;text-align:left' },
                h('div', { class: 'cnm' }, convoTitle(c), dmUnread(c) ? h('span', { class: 'udot', title: 'Unread' }) : null),
                h('div', { class: 'cpv' }, (c.last_message_text || '').replace(/<@([^>]+)>\s*/g, '@$1 ').slice(0, 60) || '—')),
            h('div', { class: 'crt' }, c.last_message_time ? ago(c.last_message_time) : ''));
    };
    const cutoff = Date.now() - 240 * 86400000;
    const recent = (S.dms || []).filter(c => (c.last_message_time || 0) >= cutoff);
    const oldConvs = (S.dms || []).filter(c => (c.last_message_time || 0) < cutoff);
    const menu = S.ui.convoOpen ? h('div', { class: 'convmenu', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'cvhd' }, h('span', null, 'LEAGUE'), h('span', { class: 'ln' })),
        h('button', { class: `conv ${convoIsLeague() ? 'on' : ''}`.trim(), onclick: switchTo('league') },
            convoIcon(null),
            h('div', { style: 'min-width:0;text-align:left' }, h('div', { class: 'cnm' }, S.league ? S.league.name : 'League', nLg ? h('span', { class: 'ucount' }, `${nLg} new`) : null), h('div', { class: 'cpv' }, `${S.rosters.length} teams`)),
            h('div', { class: 'crt' }, '')),
        h('div', { class: 'cvhd' }, h('span', null, 'DIRECT'), h('span', { class: 'ln' }), h('span', { class: 'dim' }, String((S.dms || []).length))),
        ...(S.dms == null ? [h('div', { class: 'cap' }, h('span', { class: 'spin' }), ' Reading your messages…')] : recent.map(convRow)),
        oldConvs.length ? h('button', { class: 'foldrow', onclick: (e) => { e.stopPropagation(); S.ui.dmOld = !S.ui.dmOld; render(); } },
            S.ui.dmOld ? `Hide ${oldConvs.length} older` : `${oldConvs.length} conversation${oldConvs.length === 1 ? '' : 's'} last spoke over a season ago: show`) : null,
        ...(S.ui.dmOld ? oldConvs.map(convRow) : [])) : null;
    // the badge counts what is waiting ELSEWHERE, not in the conversation on screen
    const elsewhere = (convoIsLeague() ? 0 : nLg) + (S.dms || []).filter(c => dmUnread(c) && String(c.dm_id) !== String(cid)).length;
    const picker = h('button', { class: 'cpick', title: 'Switch conversation', 'aria-haspopup': 'menu', 'aria-expanded': S.ui.convoOpen ? 'true' : 'false', onclick: (e) => { e.stopPropagation(); S.ui.convoOpen = !S.ui.convoOpen; render(); } },
        convoIcon(convoIsLeague() ? null : conv),
        h('span', { class: 'ctl' }, convoIsLeague() ? (S.league ? S.league.name : 'League chat') : convoTitle(conv)),
        caret('ccar'),
        elsewhere ? h('span', { class: 'cbadge', title: `${elsewhere} conversation${elsewhere === 1 ? '' : 's'} with something new` }, String(elsewhere)) : null);

    // ── pinned ───────────────────────────────────────────────────────────────
    const pins = S.chatPins[cid] || [];
    const pinBar = pins.length ? (() => {
        const p0 = pins[0], open = !!S.ui.pinOpen;
        return h('div', { class: `pinbar ${open ? 'open' : ''}`.trim() },
            h('button', { class: 'pinhead', 'aria-expanded': open ? 'true' : 'false', onclick: () => { S.ui.pinOpen = !open; render(); } },
                h('span', { class: 'pinlab' }, pins.length > 1 ? `PINNED · ${pins.length}` : 'PINNED'),
                h('span', { class: 'pinwho' }, p0.author_display_name || ''),
                open ? null : h('span', { class: 'pintxt' }, plain(p0.text) || (mediaOf(p0.attachment) ? 'GIF' : '')),
                caret('ccar', open)),
            open ? h('div', { class: 'pinlist' }, ...pins.map(pm => h('div', { class: 'pinitem' },
                h('div', { class: 'pinmeta' }, h('b', null, pm.author_display_name || ''), ' · ', new Date(pm.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    h('button', { class: 'mb', onclick: () => { S.ui.pinOpen = false; render(); setTimeout(() => jumpToMsgAfter(pm.message_id), 0); } }, 'GO TO')),
                h('div', { class: 't' }, ...textEl(pm))))) : null);
    })() : null;
    const jumpToMsgAfter = (id) => { const el = $(`.drawer [data-mid="${id}"]`); if (!el) { toast('That message is further back: scroll up to load older messages'); return; } V.atBottom = false; el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); };

    // ── the composer ─────────────────────────────────────────────────────────
    const rt = S.ui.replyTo;
    const send = async () => {
        const t = (S.ui.drafts[cid] || '').trim(); if (!t) return;
        const replyTo = rt;
        const pend = { key: `p${Date.now()}`, text: t, replyTo };
        (S.chatPending[cid] = S.chatPending[cid] || []).push(pend);
        S.ui.drafts[cid] = ''; S.ui.replyTo = null; S.ui.mentionQ = null; V.atBottom = true;
        render();
        const unpend = () => { S.chatPending[cid] = (S.chatPending[cid] || []).filter(x => x !== pend); };
        try {
            const m = await sendMessage(t, { parentId, parentType: chatType(cid), replyTo });
            unpend(); chatPush(cid, m); markRead(cid, m.message_id);
            render();
        } catch (err) {
            // Nothing typed is lost: the words go back in the box, the reply too.
            unpend();
            if (!(S.ui.drafts[cid] || '').trim()) S.ui.drafts[cid] = t;
            if (!S.ui.replyTo && replyTo) S.ui.replyTo = replyTo;
            render();
            toast(`Not sent: ${err.message}. Your message is back in the box.`, 'err');
        }
    };
    // Typing @ opens the room. Picking inserts Sleeper's own <@Name> syntax,
    // which is what makes the other person's phone buzz. A team name finds its
    // manager too.
    const people = () => {
        const out = [];
        if (convoIsLeague()) for (const u of S.users) { if (String(u.user_id) === String(S.myUserId)) continue; out.push({ name: u.display_name, team: (u.metadata || {}).team_name || '', av: u.avatar }); }
        else for (const u of ((conv || {}).recent_users || [])) { if (String(u.user_id) === String(S.myUserId)) continue; out.push({ name: u.display_name, team: '', av: u.avatar }); }
        return out.filter(x => x.name);
    };
    const mq = S.ui.mentionQ;
    const matches = mq == null ? [] : people().filter(p => {
        const q = mq.toLowerCase();
        return p.name.toLowerCase().startsWith(q) || (p.team && p.team.toLowerCase().split(/\s+/).some(w => w.startsWith(q))) || (q.length >= 3 && p.team.toLowerCase().includes(q));
    }).slice(0, 6);
    const idx = Math.min(Math.max(0, S.ui.mentionIdx || 0), Math.max(0, matches.length - 1));
    const grow = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 104)}px`; };
    const pick = (name) => {
        const el = $('[data-focus="chat-composer"]'); if (!el) return;
        const pos = el.selectionStart, before = el.value.slice(0, pos), after = el.value.slice(pos);
        const nb = before.replace(/@([^\s@<>]*)$/, `<@${name}> `);
        S.ui.drafts[cid] = nb + after;
        S.ui.mentionQ = null; S.ui.mentionIdx = 0;
        render();
        const again = $('[data-focus="chat-composer"]'); if (again) { again.focus(); again.setSelectionRange(nb.length, nb.length); grow(again); }
    };
    const input = h('textarea', {
        class: 'txt', rows: 1, 'data-focus': 'chat-composer', 'aria-label': convoIsLeague() ? 'Message the league' : `Message ${convoTitle(conv)}`,
        placeholder: convoIsLeague() ? 'Message the league…' : `Message ${convoTitle(conv)}…`,
        oninput: (e) => {
            S.ui.drafts[cid] = e.target.value; grow(e.target);
            const mm2 = /@([^\s@<>]*)$/.exec(e.target.value.slice(0, e.target.selectionStart));
            const q = mm2 ? mm2[1] : null;
            if (q !== S.ui.mentionQ) { S.ui.mentionQ = q; S.ui.mentionIdx = 0; render(); }
        },
        onkeydown: (e) => {
            if (matches.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); S.ui.mentionIdx = (idx + 1) % matches.length; render(); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); S.ui.mentionIdx = (idx - 1 + matches.length) % matches.length; render(); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[idx].name); return; }
            }
            if (e.key === 'Escape' && (S.ui.mentionQ != null || S.ui.replyTo)) { e.stopPropagation(); S.ui.mentionQ = null; S.ui.replyTo = null; render(); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
        },
    });
    input.value = S.ui.drafts[cid] || '';
    const mentionMenu = matches.length ? h('div', { class: 'mentmenu', role: 'listbox' },
        h('div', { class: 'cvhd' }, h('span', null, 'MENTION'), h('span', { class: 'ln' }), h('span', { class: 'dim' }, '↑↓ to move · Enter to pick')),
        ...matches.map((p, k) => h('div', { class: `mentrow ${k === idx ? 'on' : ''}`.trim(), role: 'option', 'aria-selected': k === idx ? 'true' : 'false', onmousedown: (e) => { e.preventDefault(); pick(p.name); } },
            h('div', { class: 'avatar sm' }, p.av ? h('img', { src: avatarUrl(p.av), alt: '' }) : initials(p.name)), h('b', null, p.name), p.team ? h('span', { class: 'mtm' }, p.team) : null))) : null;
    const replyBar = rt ? h('div', { class: 'replybar' },
        h('span', { class: 'qa' }, '↩ ', rt.author_display_name || 'someone'),
        h('span', { class: 'qt' }, plain(rt.text).slice(0, 90)),
        h('button', { class: 'x', title: 'Cancel reply', 'aria-label': 'Cancel reply', onclick: () => { S.ui.replyTo = null; render(); } }, '✕')) : null;
    const unseen = msgs && V.seen ? msgs.filter(m => idGt(m.message_id, V.seen) && !isMe(m)).length : 0;
    const jump = unseen && !V.atBottom ? h('button', { class: 'jumpnew', onclick: () => { V.atBottom = true; body.scrollTop = body.scrollHeight; render(); } }, `${unseen} new message${unseen === 1 ? '' : 's'} ↓`) : null;

    const d = h('div', { class: 'drawer', role: 'dialog', 'aria-label': 'Messages', onclick: () => { if (S.ui.convoOpen) { S.ui.convoOpen = false; render(); } } },
        h('div', { class: 'dh' }, picker, h('span', { style: 'flex:1' }),
            h('button', { class: 'btn sm s', onclick: () => { S.ui.chat = false; render(); } }, 'Close · Esc'), menu),
        pinBar,
        h('div', { class: 'dbwrap' }, body, jump),
        h('div', { class: 'df' }, mentionMenu, replyBar, h('div', { class: 'dfrow' }, input, h('button', { class: 'btn p', onclick: send }, 'Send')),
            h('div', { class: 'dfhint' }, 'Enter to send · Shift+Enter for a new line')));
    // Scroll: first open lands on the NEW line (or the end); after that, stay
    // pinned to the end only if you were there, and keep your place if you were
    // reading back. Loading older history keeps the message under your eye still.
    setTimeout(() => {
        if (!body.isConnected) return;
        grow(input);
        if (msgs == null) return;
        if (V.fresh) {
            V.fresh = false;
            const all = chatList(cid) || []; if (all.length) V.seen = String(all[all.length - 1].message_id);
            const nl = body.querySelector('.newline');
            if (nl && nl.offsetTop > body.clientHeight * 0.6) { body.scrollTop = Math.max(0, nl.offsetTop - 48); V.atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60; }
            else { body.scrollTop = body.scrollHeight; V.atBottom = true; }
        } else if (V.restore) {
            V.restore = false;
            body.scrollTop = body.scrollHeight - V.prevHeight + V.prevTop;
        } else if (V.atBottom) body.scrollTop = body.scrollHeight;
        if (V.atBottom) markNewest();
    }, 0);
    return d;
}
// ── Sleeper's weekly report ──────────────────────────────────────────────────
// Sleeper posts it as a chat message whose attachment carries the whole report;
// its web client has no page for it, only a pop-up. So the card opens our own
// view of the same data, with a way on to that week's Scoreboard.
function repTeam(d, rid) {
    const R = rosterById(rid);
    if (R) return { R, name: teamName(R), face: (cls) => avatarEl(R, cls), mine: !!S.myRoster && S.myRoster.roster_id === Number(rid) };
    const u = ((d && d.roster_user_map) || {})[String(rid)] || {};
    const name = ((u.metadata || {}).team_name || '').trim() || u.display_name || `Team ${rid}`;
    const src = (u.metadata || {}).avatar || (u.avatar ? avatarUrl(u.avatar) : null);
    return { R: null, name, face: (cls) => h('div', { class: `avatar ${cls || ''}` }, src ? h('img', { src, alt: '' }) : initials(name)), mine: false };
}
function reportCard(d) {
    const row = (label, rid, text, val) => { const t = repTeam(d, rid); return h('div', { class: `aw ${t.mine ? 'you' : ''}`.trim() }, t.face('xs'), h('div', { style: 'min-width:0' }, h('div', { class: 'awl' }, label), h('div', { class: 'awn' }, text || t.name)), h('span', { class: 'awv' }, val)); };
    const pair = (x) => x ? `${repTeam(d, x.roster_id_1).name} over ${repTeam(d, x.roster_id_2).name}` : '';
    const margin = (x) => x ? fmtS(Math.abs((x.points_1 || 0) - (x.points_2 || 0))) : '';
    return h('div', { class: 'repc' },
        h('div', { class: 'reph' }, `WEEK ${d.week || '?'} REPORT`),
        d.highest_scorer ? row('HIGHEST SCORER', d.highest_scorer.roster_id, null, fmtS(d.highest_scorer.points)) : null,
        d.blowout ? row('BLOWOUT', d.blowout.roster_id_1, pair(d.blowout), margin(d.blowout)) : null,
        d.nailbiter ? row('NAILBITER', d.nailbiter.roster_id_1, pair(d.nailbiter), margin(d.nailbiter)) : null,
        d.lowest_scorer ? row('LOWEST SCORER', d.lowest_scorer.roster_id, null, fmtS(d.lowest_scorer.points)) : null,
        h('div', { class: 'btnrow' }, h('button', { class: 'btn sm p', onclick: (e) => { e.stopPropagation(); S.ui.report = d; render(); } }, 'Open the report')));
}
function reportModal(d) {
    const wk = Number(d.week) || null;
    const close = () => { S.ui.report = null; render(); };
    const award = (label, rid, whoText, fact, involved) => {
        const t = repTeam(d, rid);
        const you = (involved || [rid]).some(x => S.myRoster && Number(x) === S.myRoster.roster_id);
        return h('div', { class: `award ${you ? 'you' : ''}`.trim() }, h('div', { class: 'k' }, label),
            h('div', { class: 'who' }, t.face('sm'), h('span', null, whoText || t.name)), h('div', { class: 'fact' }, ...fact));
    };
    const b = (v) => h('b', null, v);
    const pair = (x) => `${repTeam(d, x.roster_id_1).name} over ${repTeam(d, x.roster_id_2).name}`;
    const awards = [];
    if (d.highest_scorer) { const o = d.overachiever && d.overachiever.roster_id === d.highest_scorer.roster_id ? d.overachiever : null; awards.push(award('HIGHEST SCORER', d.highest_scorer.roster_id, null, [b(fmtS(d.highest_scorer.points)), o && o.proj_points != null ? `, ${fmtS(o.points - o.proj_points)} over projection` : ''])); }
    if (d.lowest_scorer) awards.push(award('LOWEST SCORER', d.lowest_scorer.roster_id, null, [b(fmtS(d.lowest_scorer.points))]));
    if (d.blowout) awards.push(award('BLOWOUT', d.blowout.roster_id_1, pair(d.blowout), [b(`${fmtS(d.blowout.points_1)} – ${fmtS(d.blowout.points_2)}`), `, by ${fmtS(Math.abs(d.blowout.points_1 - d.blowout.points_2))}`], [d.blowout.roster_id_1, d.blowout.roster_id_2]));
    if (d.nailbiter) awards.push(award('NAILBITER', d.nailbiter.roster_id_1, pair(d.nailbiter), [b(`${fmtS(d.nailbiter.points_1)} – ${fmtS(d.nailbiter.points_2)}`), `, by ${fmtS(Math.abs(d.nailbiter.points_1 - d.nailbiter.points_2))}`], [d.nailbiter.roster_id_1, d.nailbiter.roster_id_2]));
    if (d.highest_loser) awards.push(award('HIGHEST LOSER', d.highest_loser.roster_id_1, null, [b(fmtS(d.highest_loser.points_1)), ' and still lost']));
    if (d.lowest_winner) awards.push(award('LOWEST WINNER', d.lowest_winner.roster_id_1, null, ['won with ', b(fmtS(d.lowest_winner.points_1))]));
    if (d.best_manager) awards.push(award('BEST MANAGER', d.best_manager.roster_id, null, ['started ', b(fmtS(d.best_manager.points)), ' of a possible ', b(fmtS(d.best_manager.max_points))]));
    if (d.worst_manager) awards.push(award('WORST MANAGER', d.worst_manager.roster_id, null, ['started ', b(fmtS(d.worst_manager.points)), ' of a possible ', b(fmtS(d.worst_manager.max_points))]));
    if (d.overachiever && !(d.highest_scorer && d.highest_scorer.roster_id === d.overachiever.roster_id)) awards.push(award('OVERACHIEVER', d.overachiever.roster_id, null, [b(fmtS(d.overachiever.points)), ' on a ', b(fmtS(d.overachiever.proj_points)), ' projection']));
    if (d.underachiever) awards.push(award('UNDERACHIEVER', d.underachiever.roster_id, null, [b(fmtS(d.underachiever.points)), ' on a ', b(fmtS(d.underachiever.proj_points)), ' projection']));
    const ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
    const players = (obj, bench) => ORDER.filter(k => obj && obj[k] && obj[k].player).map(k => {
        const x = obj[k], pl = x.player, t = repTeam(d, x.roster_id), pid = String(pl.player_id || '');
        const nm = pl.position === 'DEF' ? `${pl.first_name || ''} ${pl.last_name || ''}`.trim() : `${pl.first_name || ''} ${pl.last_name || ''}`.trim();
        return h('button', { class: `rstar ${bench ? 'bench' : ''} ${t.mine ? 'you' : ''}`.replace(/\s+/g, ' ').trim(), title: `${nm}, ${t.name}`, onclick: () => { if (pid) { S.ui.sel = pid; render(); } } },
            h('img', { class: 'rhs', src: headshot(pid), alt: '', loading: 'lazy', onerror: hideBroken }),
            h('span', { class: `pos txt ${pl.position || k}` }, posLabel(pl.position || k)),
            h('span', { class: 'rpn' }, nm), h('span', { class: 'rpts mono' }, fmtS(x.points)),
            h('span', { class: 'rown' }, t.mine ? `${t.name} · you` : t.name));
    });
    const stars = players(d.stars, false), bench = players(d.bench, true);
    const st = (d.standings || []).slice().sort((x, y) => (x.rank || 99) - (y.rank || 99));
    return h('div', { class: 'modal-bg', onclick: close },
        h('div', { class: 'modal repmodal', role: 'dialog', 'aria-label': `Week ${wk} report`, onclick: (e) => e.stopPropagation() },
            h('div', { class: 'rmh' }, h('h3', null, `Week ${wk || '?'} report`), h('span', { class: 'dim' }, `${S.league ? S.league.name : ''} · from Sleeper’s weekly report`),
                h('button', { class: 'btn sm s', style: 'margin-left:auto', onclick: close }, 'Close · Esc')),
            awards.length ? [h('div', { class: 'rsec' }, 'AWARDS'), h('div', { class: 'awards' }, ...awards)] : null,
            h('div', { class: 'rsplit' },
                h('div', null,
                    stars.length ? [h('div', { class: 'rsec' }, 'STARS OF THE WEEK'), h('div', { class: 'rstars' }, ...stars)] : null,
                    bench.length ? [h('div', { class: 'rsec' }, 'LEFT ON A BENCH'), h('div', { class: 'rstars' }, ...bench)] : null),
                st.length ? h('div', null, h('div', { class: 'rsec' }, `STANDINGS AFTER WEEK ${wk || '?'}`),
                    h('div', { class: 'tscroll' }, h('table', { class: 'rstand' },
                        h('tr', null, h('th', null, '#'), h('th', null, 'TEAM'), h('th', { class: 'r' }, 'W–L'), h('th', { class: 'r' }, 'PF')),
                        ...st.map(x => { const t = repTeam(d, x.roster_id); return h('tr', { class: t.mine ? 'you' : '' },
                            h('td', { class: 'mono' }, String(x.rank || '')), h('td', null, h('span', { class: 'rteam' }, t.face('xs'), h('span', null, t.name))),
                            h('td', { class: 'r mono' }, `${x.wins || 0}–${x.losses || 0}${x.ties ? '–' + x.ties : ''}`), h('td', { class: 'r mono' }, fmtS(x.points))); })))) : null),
            wk ? h('div', { class: 'rfoot' },
                h('button', { class: 'btn p', onclick: () => { S.ui.report = null; S.ui.chat = false; S.ui.weekPicked = true; S.week = wk; S.ui.muView = 'all'; go('matchup'); } }, `See every week ${wk} matchup →`),
                h('span', { class: 'dim' }, `Opens the Scoreboard on week ${wk}, all matchups.`)) : null));
}
// The system row's avatar: a notice about ONE team wears that team's mark;
// league-wide ones (and trades, which belong to two) keep Sleeper's icon.
function actorIcon2(m, deent, chatAvatar) {
    try {
        const att = m.attachment;
        const d = att && !Array.isArray(att) && att.data;
        if (d && !Array.isArray(d) && d.user) return chatAvatar((d.user.metadata || {}).avatar || d.user.avatar);
        if (Array.isArray(d)) {
            const users = [];
            for (const txn of d) { const byR = txn && txn.transactions_by_roster; if (byR) for (const rid in byR) { const u = byR[rid].user; if (u && u.avatar) users.push(u.avatar); } }
            if (users.length === 1) return chatAvatar(users[0]);
            if (users.length > 1) return null;
        }
        const txt = deent(m.text);
        const u2 = S.users.find(x => x.display_name && txt.startsWith(x.display_name));
        if (u2) return chatAvatar((u2.metadata || {}).avatar || u2.avatar);
    } catch (e) { /* fall back to the Sleeper icon */ }
    return null;
}
// The card's tabs. It remembers the last one used, so someone who always
// checks usage lands on it; a kicker or defence has no Usage tab. The game log
// used to be a tab of its own (History): it leads Overview now.
function cardTab(pid) {
    if (S.ui.cardTab === undefined) { try { S.ui.cardTab = localStorage.getItem('badgerCardTab') || 'overview'; } catch (e) { S.ui.cardTab = 'overview'; } }
    if (S.ui.cardTab !== 'usage' && S.ui.cardTab !== 'news') S.ui.cardTab = 'overview';
    return S.ui.cardTab === 'usage' && !usageKeyOf(ppos(pid)) ? 'overview' : S.ui.cardTab;
}
function cardTabs(pid) {
    const cur = cardTab(pid);
    const tabs = [['overview', 'Overview'], ...(usageKeyOf(ppos(pid)) ? [['usage', 'Usage']] : []), ['news', 'News & moves']];
    const pick = (k) => () => { S.ui.cardTab = k; try { localStorage.setItem('badgerCardTab', k); } catch (e) { /* remembered for this visit only */ } render(); };
    return h('div', { class: 'ctabs', role: 'tablist' }, ...tabs.map(([k, t]) => h('span', { class: k === cur ? 'on' : '', role: 'tab', tabindex: '0', 'aria-selected': String(k === cur), 'data-focus': `ctab:${k}`, onclick: pick(k), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(k)(); } } }, t)));
}
// Is every game of the week over? Until then a week's rank is "so far".
function weekAllOver(week) {
    if (week < S.curWeek) return true;
    const over = (k) => !!(k && (k.over || k.q === 'F' || /complete|closed/i.test(k.status || '')));
    if (S.kickWeek === week && S.kick) { const v = Object.values(S.kick).filter(Boolean); if (v.length) return v.every(over); }
    const v = Object.values((S.schedule || {})[week] || {}).filter(Boolean);
    return v.length ? v.every(x => /complete|closed/i.test(x.status || '')) : false;
}
// Is his team's game that week finished? The kickoff map when it is that
// week's, the schedule's status otherwise.
function teamGameOver(pid, week) {
    if (week < S.curWeek) return true;
    const team = (P(pid) || {}).team || (/^[A-Z]{2,3}$/.test(pid) ? pid : null);
    if (!team) return false;
    const done = (x) => !!(x && (x.over || x.q === 'F' || /complete|closed/i.test(x.status || '')));
    if (S.kickWeek === week && S.kick && S.kick[team]) return done(S.kick[team]);
    return done(((S.schedule || {})[week] || {})[team]);
}
// What is left to play, summed from Sleeper's weekly projections: from this
// week until its first kickoff, from next week after. The weeks are loaded once
// a session, the same ones the Players table's rest-of-season reads.
function cardRos() {
    const cur = Math.max(1, S.curWeek), from = weekKicks(cur).some(t => t <= Date.now()) ? cur + 1 : cur, to = LAST_WEEK;
    if (!(S.ros && S.rosFrom === cur)) {
        if (!S.rosLoading && S.seasonType === 'regular' && cur <= LAST_WEEK) { S.rosLoading = true; loadRos().then(() => { S.rosLoading = false; render(); }).catch(() => { S.rosLoading = false; }); }
        return { from, to, ready: false };
    }
    if (S.cardRosMemo && S.cardRosMemo.from === from && S.cardRosMemo.src === S.ros) return S.cardRosMemo;
    const pool = {};
    for (let w = from; w <= to; w++) for (const [pid, x] of Object.entries(S.proj[w] || {})) { if (!x || x.pts == null) continue; const e = pool[pid] = pool[pid] || { pts: 0, gp: 0 }; e.pts += x.pts; e.gp += 1; }
    return (S.cardRosMemo = { from, to, ready: true, pool, src: S.ros });
}
// Four numbers under the name, on every tab: what he has scored, what he is
// doing this week, and what is projected for next week and for what is left —
// each by this league's scoring, with his rank at his position. A projection
// is dimmed and says so.
function cardStrip(pid) {
    const p0 = ppos(pid), cur = S.curWeek;
    if (S.seasonType !== 'regular' || S.fracDone || !POS_ORDER.includes(p0) || !(cur >= 1) || cur > LAST_WEEK) return null;
    const pos = posLabel(p0), lg = (S.league && S.league.name) || 'this league';
    // each thing the strip reads is asked for once per card, so a week Sleeper has nothing for cannot be asked for in a loop
    const asked = (S.cardAsked = S.cardAsked || {});
    const need = (key, has, run) => { if (has || asked[`${pid}:${key}`]) return; asked[`${pid}:${key}`] = true; once(`card:${key}`, run).then(render).catch(() => {}); };
    need('season', !!S.seasonStats, loadSeasonStats); need(`stats${cur}`, !!S.stats[cur], () => loadStats(cur)); need(`proj${cur}`, !!S.proj[cur], () => loadProj(cur));
    const nw = cur + 1; if (nw <= LAST_WEEK) need(`proj${nw}`, !!S.proj[nw], () => loadProj(nw));
    const team = (P(pid) || {}).team || (p0 === 'DEF' ? pid : null);
    const wkOf = (w) => { const g = gameOf(pid, w); return g ? `Wk ${w} ${g.home ? 'vs ' : '@'}${g.opp}` : `Wk ${w}`; };
    const many = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const ranked = (pool, has) => { const r = has && poolRanks(pool); return { rk: r ? r.pos[pid] || null : null, n: r ? r.n[p0] || 0 : 0, all: r ? r.overall[pid] || null : null }; };
    // the season so far
    const sea = (S.seasonStats || {})[pid];
    let tSea;
    if (!S.seasonStats) tSea = { v: '…' };
    else if (!sea || !sea.gp) tSea = { v: '—', s1: 'no games yet' };
    else { const r = ranked(S.seasonStats, true); tSea = { v: fmt1(sea.pts), ...r, q: r.all ? `#${r.all} overall` : '', s1: many(sea.gp, 'game'), s2: `${fmt1(sea.pts / sea.gp)} a game` }; }
    // this week: the score once his game has started, the projection before
    const act = (S.stats[cur] || {})[pid], pr = (S.proj[cur] || {})[pid], hasPr = !!(pr && pr.pts != null);
    let tWk;
    if (!team) tWk = { v: '\u2014', s1: `Wk ${cur}`, s2: 'no team' };
    else if (isBye(pid, cur)) tWk = { v: 'BYE', s1: `Wk ${cur}`, s2: 'no game' };
    else if (playedWeek(pid, cur) || teamKickedOff(pid, cur) === true) { const had = !!(act && act.pts != null); tWk = { v: had ? fmtS(act.pts) : '—', ...ranked(S.stats[cur], had), q: weekAllOver(cur) ? '' : 'so far', s1: wkOf(cur), s2: hasPr ? `proj was ${fmt1(pr.pts)}` : !had && teamGameOver(pid, cur) ? 'did not play' : '' }; }
    else { const k = insKickInfo(pid), at = S.kickWeek === cur && k && k.t ? Date.parse(k.t) : null; tWk = { proj: true, v: hasPr ? fmt1(pr.pts) : S.proj[cur] ? '—' : '…', ...ranked(S.proj[cur], hasPr), q: 'projected', s1: wkOf(cur), s2: at ? dayTime(at) : 'Sleeper projection' }; }
    // next week
    let tNx;
    if (nw > LAST_WEEK) tNx = { v: '—', s1: 'season over' };
    else if (!team) tNx = { v: '\u2014', s1: `Wk ${nw}`, s2: 'no team' };
    else if (isBye(pid, nw)) tNx = { v: 'BYE', s1: `Wk ${nw}`, s2: 'no game' };
    else { const e = (S.proj[nw] || {})[pid], has = !!(e && e.pts != null); tNx = { proj: true, v: has ? fmt1(e.pts) : S.proj[nw] ? '—' : '…', ...ranked(S.proj[nw], has), q: 'projected', s1: wkOf(nw), s2: 'Sleeper projection' }; }
    // what is left
    const ros = cardRos(), span = ros.from === ros.to ? `Wk ${ros.from}` : `Wks ${ros.from}–${ros.to}`;
    let tRos;
    if (ros.from > ros.to) tRos = { v: '—', s1: 'season over' };
    else if (!ros.ready) tRos = { proj: true, v: '…', s1: span };
    else { const e = ros.pool[pid]; tRos = { proj: true, v: e ? fmt0(e.pts) : '—', ...ranked(ros.pool, !!e), q: 'projected', s1: span, s2: e ? many(e.gp, 'game') : '' }; }
    const tile = (k, o) => h('div', { class: `pt ${o.proj ? 'proj' : ''}`.trim() },
        h('div', { class: 'k' }, k), h('div', { class: 'v' }, o.v),
        h('div', { class: 'rkrow', title: o.rk ? `${pos}${o.rk} of ${o.n} ${pos}s, by ${lg}’s scoring` : null }, o.rk ? [h('b', { class: `pos txt ${p0}` }, `${pos}${o.rk}`), o.q ? ` ${o.q}` : null] : null),
        h('div', { class: 'sub' }, h('span', null, o.s1 || ''), h('span', null, o.s2 || '')));
    return [h('div', { class: 'pstrip' }, tile('Season', tSea), tile('This week', tWk), tile('Next week', tNx), tile('Rest of season', tRos)),
        h('div', { class: 'pcap' }, `By ${lg}’s scoring. Ranks are among all ${pos}s.`)];
}
// Where a story came from: a link out when Sleeper carries one.
const newsSource = (n) => { const u = (n.metadata || {}).url; return u ? h('a', { class: 'srclink', href: u, target: '_blank', rel: 'noopener noreferrer', title: 'Read it at the source' }, sourceLabel(n), ' ↗') : h('span', null, sourceLabel(n)); };
// The card's nickname, under his name. Yours you can name, rename or clear; another team's is theirs, said as theirs.
function cardNick(pid, owner) {
    if (!owner) return null;
    const mine = !!S.myRoster && owner.roster_id === S.myRoster.roster_id, nk = nickOf(pid), ed = S.ui.nickEdit && S.ui.nickEdit.pid === pid ? S.ui.nickEdit : null;
    if (mine && ed) return nickEditor(pid, ed, nk);
    if (!mine) { const tn = String(teamName(owner)).trim(); return nk ? h('div', { class: 'cnick' }, h('q', { class: 'nkq' }, nk), h('span', { class: 'whose' }, `${tn}${/s$/i.test(tn) ? '’' : '’s'} name for him`)) : null; }
    const open = () => { S.ui.nickEdit = { pid, v: nk || '', busy: false }; render(); };
    return h('div', { class: 'cnick' }, nk ? h('q', { class: 'nkq mine' }, nk) : null,
        h('button', { class: 'lnk', type: 'button', 'data-act': 'nick-edit', 'data-focus': `nick-edit:${pid}`, onclick: open },
            nk ? [sv('svg', { class: 'pen', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, sv('path', { d: 'M3 11.5V13h1.5l7-7L10 4.5l-7 7Zm9.7-6.3a.7.7 0 0 0 0-1l-.9-.9a.7.7 0 0 0-1 0l-.7.7 1.9 1.9.7-.7Z' })), 'Edit nickname'] : '+ Add a nickname'));
}
function nickEditor(pid, ed, nk) {
    const cnt = h('span', { class: 'nkc mono' }, `${ed.v.length}/30`);
    const close = () => { S.ui.nickEdit = null; render(); };
    const inp = h('input', { class: 'nkin', id: `nick-${pid}`, maxlength: '30', value: ed.v, placeholder: 'Up to 30 characters', autocomplete: 'off', 'data-focus': `nick:${pid}`, disabled: ed.busy,
        oninput: (e) => { ed.v = e.target.value; cnt.textContent = `${ed.v.length}/30`; },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveNickname(pid, ed.v); } else if (e.key === 'Escape') { e.stopPropagation(); close(); } } });
    if (!ed.focused) { ed.focused = true; setTimeout(() => { if (inp.isConnected) { inp.focus(); inp.select(); } }, 0); }
    return h('div', { class: 'nked' }, h('label', { class: 'nkl', for: `nick-${pid}` }, 'Nickname'), h('div', { class: 'nkrow' }, inp, cnt),
        h('div', { class: 'nkact' },
            h('button', { class: 'btn p sm', type: 'button', 'data-act': 'nick-save', disabled: ed.busy, onclick: () => saveNickname(pid, ed.v) }, ed.busy ? 'Saving…' : 'Save'),
            h('button', { class: 'btn s sm', type: 'button', 'data-act': 'nick-cancel', disabled: ed.busy, onclick: close }, 'Cancel'),
            nk ? h('button', { class: 'lnk red', type: 'button', 'data-act': 'nick-clear', disabled: ed.busy, onclick: () => saveNickname(pid, '') }, 'Remove nickname') : null),
        h('div', { class: 'nknote' }, 'Sleeper posts a new nickname in league chat. Removing one posts nothing.'));
}
// Sleeper keeps a team's nicknames with the rest of its team settings (record, streak, notification choices), and
// its save REPLACES the whole set: a key sent alone wipes the others (seen in the test league). So the team's set is
// read fresh, one name changed, and all of it sent back; if the read fails, nothing is sent.
async function saveNickname(pid, v) {
    const ed = S.ui.nickEdit, my = S.myRoster; if (!ed || ed.busy || !my) return;
    const val = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 30), was = nickOf(pid) || '';
    if (val === was) { S.ui.nickEdit = null; render(); return; }
    ed.busy = true; render();
    try {
        const fresh = (await rest(`${API}/league/${S.leagueId}/rosters`)).find(r => r.roster_id === my.roster_id);
        if (!fresh) throw new Error('Sleeper did not send your team back, so the nickname was not changed.');
        const md = Object.assign({}, fresh.metadata || {}, { [`p_nick_${pid}`]: val }), keys = Object.keys(md);
        const d = await gql('roster_update_metadata', `mutation roster_update_metadata($k_metadata: [String], $v_metadata: [String]) { roster_update_metadata(league_id: "${S.leagueId}", roster_id: ${my.roster_id}, k_metadata: $k_metadata, v_metadata: $v_metadata){ roster_id metadata } }`,
            { k_metadata: keys, v_metadata: keys.map(k => (md[k] == null ? '' : String(md[k]))) });
        const back = (d && d.roster_update_metadata && d.roster_update_metadata.metadata) || md;
        for (const R of new Set([my, S.rosters.find(r => r.roster_id === my.roster_id)])) if (R) R.metadata = back;
        S.ui.nickEdit = null;
        toast(val ? `Nickname saved: “${val}”` : 'Nickname removed', 'ok');
    } catch (e) { ed.busy = false; toast(String(e.message || e), 'err'); }
    render();
}
const newsAge = (n) => { const a = ago(n.published); return a === 'now' ? 'just now' : `${a} ago`; };
// The newest story leads Overview: it is the freshest thing known about him.
// The ones before it are a tab away.
function cardNewsTop(pid) {
    const n = /^[A-Z]{2,3}$/.test(pid) ? false : S.news[pid];
    if (n === undefined) { once(`news:${pid}`, () => loadNews([pid])).then(render); return h('div', { class: 'cnewstop dim' }, 'Loading news…'); }
    if (!n) return h('div', { class: 'cnewstop dim' }, 'No recent news.');
    const md = n.metadata || {};
    return h('div', { class: 'cnewstop' }, h('div', { class: 'news-t' }, md.title || ''), h('div', { class: 'news-d' }, md.description || ''),
        md.analysis ? h('div', { class: 'news-d', style: 'margin-top:6px;color:var(--ink)' }, md.analysis) : null,
        h('div', { class: 'newsmeta' }, h('span', { title: new Date(n.published).toLocaleString() }, newsAge(n), ' · ', newsSource(n)),
            h('button', { class: 'lnk', type: 'button', 'data-focus': 'card-older', onclick: () => { S.ui.cardTab = 'news'; render(); } }, 'Older news')));
}
// News & moves: his last ten stories as headlines, the newest open, each one
// opening in place; then what this league has done with him.
function cardNewsTab(pid) {
    const out = [];
    if (/^[A-Z]{2,3}$/.test(pid)) out.push(h('div', { class: 'cap' }, 'Sleeper carries no news for a team defence.'));
    else {
        const M = (S.newsMore || {})[pid], busy = () => h('div', { class: 'cap' }, h('span', { class: 'spin' }), ' Reading his news…');
        if (!M || (M.error && Date.now() - M.at > 30000)) { loadNewsMore(pid).then(render); out.push(busy()); }
        else if (M.loading) out.push(busy());
        else if (M.error) out.push(h('div', { class: 'cap' }, `Sleeper did not return his news (${M.error}).`));
        else if (!M.items.length) out.push(h('div', { class: 'cap' }, 'Sleeper has no news on him.'));
        else {
            if (!S.ui.cardNews || S.ui.cardNews.pid !== pid) S.ui.cardNews = { pid, open: new Set([0]) };
            const open = S.ui.cardNews.open;
            out.push(h('div', { class: 'cnews' }, ...M.items.map((n, i) => { const md = n.metadata || {}, on = open.has(i);
                return h('div', { class: `cnrow ${on ? 'open' : ''}`.trim() },
                    h('button', { class: 'cnhead', type: 'button', 'aria-expanded': String(on), 'data-focus': `cnews:${i}`, onclick: () => { if (on) open.delete(i); else open.add(i); render(); } },
                        foldCaret(on), h('span', { class: 't' }, md.title || 'Untitled'), h('span', { class: 'when', title: new Date(n.published).toLocaleString() }, ago(n.published))),
                    on ? h('div', { class: 'cnbody' }, md.description ? h('div', { class: 'news-d' }, md.description) : null, md.analysis ? h('div', { class: 'news-d', style: 'margin-top:6px;color:var(--ink)' }, md.analysis) : null, h('div', { class: 'cnsrc' }, newsSource(n))) : null); })),
                h('div', { class: 'cap' }, M.items.length >= NEWS_MORE ? `His last ${NEWS_MORE} stories on Sleeper.` : `Every story Sleeper has on him.`));
        }
    }
    out.push(historyBlock(pid) || h('div', { class: 'cap' }, 'Loading this league’s moves on him…'));
    return out;
}
function playerModal(pid) {
    const pl = P(pid) || {};
    const owner = S.rosters.find(r => (r.players || []).includes(pid));
    const strip = cardStrip(pid), tab = cardTab(pid);
    // Outside the season there is no week to stand in: the card keeps its old
    // Overview, the weeks from the one on screen and the totals Sleeper has.
    const weeks = []; if (!strip) for (let w = S.week; w <= Math.min(18, S.week + 5); w++) { const gg = gameOf(pid, w); weeks.push(h('div', { style: 'background:var(--card-2);border-radius:8px;padding:6px 8px;text-align:center' }, h('div', { class: 'dim', style: 'font-size:10px;font-weight:800' }, `WK ${w}`), h('div', { class: 'mono', style: 'font-size:12px' }, gg ? `${gg.home ? 'vs ' : '@'}${gg.opp}` : 'BYE'), h('div', { class: 'mono dim', style: 'font-size:11px' }, fmt1(projOf(pid, w) ?? null)))); }
    const injury = pl.injury_notes ? h('div', { class: 'cap' }, `Injury: ${pl.injury_notes}${pl.practice_participation ? ' · practice ' + pl.practice_participation : ''}`) : null;
    // One height on every tab: the head and the tabs stay where they are, the
    // tab scrolls beneath them, and the actions stay docked at the bottom — a
    // card that grew and shrank with each tab moved the tabs out from under
    // the mouse.
    return h('div', { class: 'modal-bg', onclick: () => { S.ui.sel = null; S.ui.dropAsk = null; render(); } }, h('div', { class: 'modal pmodal', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'phead' }, h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:10px' }, h('div', { class: 'avatar lg' }, h('img', { src: headshot(pid), alt: '', onerror: (e) => e.target.remove() })), h('div', null, h('h3', null, pname(pid), ' ', h('span', { class: `pos txt ${pl.position}` }, posLabel(pl.position)), ' ', starEl(pid)), cardNick(pid, owner), h('div', { class: 'dim', style: 'font-size:12px' }, `${pl.team || 'FA'}${pl.number ? ' #' + pl.number : ''}${pl.age ? ' · Age ' + pl.age : ''}${pl.years_exp != null ? ' · ' + (pl.years_exp === 0 ? 'rookie' : pl.years_exp + ' yrs') : ''}${pl.depth_chart_order ? ' · ' + pl.depth_chart_position + pl.depth_chart_order : ''}`)),
            strip ? null : (() => {
                // Once his game has kicked off, the headline is what he scored and
                // the projection steps down to the label. Before, it is the forecast.
                const act = (S.stats[S.week] || {})[pid], pr = projOf(pid, S.week);
                const scored = act && act.pts != null && gameFracLeft(pid) < 1;
                return h('div', { style: 'margin-left:auto;text-align:right' },
                    h('div', { class: 'mono', style: 'font-size:20px;font-weight:600' }, scored ? fmtS(act.pts) : fmt1(pr)),
                    h('div', { class: 'dim', style: 'font-size:10px;letter-spacing:0.08em;font-weight:800' }, scored ? `WK ${S.week}${pr != null ? ` · ${fmt1(pr)} PROJ` : ''}` : `PROJ WK ${S.week}`));
            })()),
        h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px' }, statusChip(pid, S.week), owner ? h('span', { class: `chip ${S.myRoster && owner.roster_id === S.myRoster.roster_id ? 'teal' : ''}` }, S.myRoster && owner.roster_id === S.myRoster.roster_id ? 'On your roster' : teamName(owner)) : h('span', { class: 'chip green' }, 'Available'), S.research && S.research[pid] ? h('span', { class: 'chip' }, `${Math.round(S.research[pid].owned)}% owned · ${Math.round(S.research[pid].started)}% started`) : null),
        strip,
        cardTabs(pid)),
        h('div', { class: 'pbody', 'data-keep': `card:${pid}:${tab}` }, ...(tab === 'usage' ? [usageBlock(pid)] : tab === 'news' ? cardNewsTab(pid)
            : strip ? [cardNewsTop(pid), injury, seasonTimeline(pid)]
            : [h('div', { style: 'display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin-bottom:10px' }, ...weeks), cardNewsTop(pid), injury, splitsBlock(pid)])),
        // One action, whoever holds him: sign / claim if free, trade if someone
        // else's, drop if yours. It anchors LEFT with Close on the right — a
        // destructive button should never sit beside the dismiss button — and
        // Drop asks in the card rather than firing.
        modalFoot(pid, owner)));
}

function modalFoot(pid, owner) {
    const mine = owner && S.myRoster && owner.roster_id === S.myRoster.roster_id;
    if (mine && S.ui.dropAsk === pid) {
        const wi = waiverInfo();
        return h('div', { class: 'mfoot ask' },
            h('span', null, h('b', null, `Drop ${pname(pid)}?`), allOnWaivers() || wi.dayIdx != null || ((S.league.settings || {}).waiver_clear_days || 0) > 0 ? ' He goes to waivers.' : ' This is immediate.'),
            h('button', { class: 'btn ghost', style: 'margin-left:auto', onclick: () => { S.ui.dropAsk = null; render(); } }, 'Cancel'),
            h('button', { class: 'btn danger', 'data-act': 'drop-confirm', onclick: () => { S.ui.dropAsk = null; S.ui.sel = null; act(() => addDrop({}, { [pid]: S.myRoster.roster_id }), `${pname(pid)} dropped`); } }, 'Yes, drop him'));
    }
    return h('div', { class: 'mfoot' },
        !owner && S.myRoster ? h('button', { class: 'btn p', onclick: () => { S.ui.sel = null; go('players'); openComposer(pid, onWaiversNow(pid)); } }, onWaiversNow(pid) ? 'Claim' : '+ Add') : null,
        owner && !mine && S.myRoster ? h('button', { class: 'btn', onclick: () => { S.ui.sel = null; openTrade(owner.roster_id, pid); } }, `⇄ Trade with ${teamName(owner).slice(0, 16)}`) : null,
        mine ? h('button', { class: 'btn danger', 'data-act': 'drop', onclick: () => { S.ui.dropAsk = pid; render(); } }, 'Drop') : null,
        h('button', { class: 'btn s', style: 'margin-left:auto', onclick: () => { S.ui.sel = null; S.ui.dropAsk = null; render(); } }, 'Close'));
}
// ── kickoff times (GraphQL scores; the schedule REST has only dates) ─────────
async function loadKickoffs(force, w = S.week) {
    if (!force && S.kick && S.kickWeek === w) return;
    S.kickByWeek = S.kickByWeek || {};
    // A week already fetched this visit becomes current at once; a live one is
    // re-read when forced.
    if (!force && S.kickByWeek[w]) { S.kick = S.kickByWeek[w]; S.kickWeek = w; return; }
    try {
        const d = await gql('scores', `query scores { scores(sport: "nfl", season_type: "regular", season: "${S.season}", week: ${w}){ game_id metadata status } }`);
        const m = {};
        // One record per game, shared by both teams: kickoff, channel, live
        // score and quarter. The player rows read it to decide whether their
        // sub-line is a schedule or a box score.
        for (const g of (d.scores || [])) { const rec = kickRec(g); if (rec) { m[rec.home] = rec; m[rec.away] = rec; } }
        // Stamped with the week it was ASKED for. It used to take whatever week was
        // on screen when the answer landed: open Home (week 2), click Scoreboard
        // (week 1) before it answered, and week 2's games were filed as week 1's.
        S.kickByWeek[w] = m;
        if (S.week === w) { S.kick = m; S.kickWeek = w; }
        projKickSync(w);
    } catch (e) { console.warn(TAG, 'kickoffs:', e.message); S.kick = S.kick || {}; }
}
function kickRec(g) {
            const md = g.metadata || {}, t0 = md.date_time || g.start_time; if (!t0) return null;
            const rec = { gid: g.game_id, t: t0, status: g.status, ch: md.channel || null,
                home: md.home_team, away: md.away_team, hs: md.home_score, as: md.away_score,
                q: md.quarter || null, qn: md.quarter_num || null, tr: md.time_remaining || null,
                live: !!md.is_in_progress, over: !!md.is_over, started: !!md.has_started,
                // the Scoreboard's NFL games: quarters, records, line, weather, and the field while live
                aq: [1, 2, 3, 4].map(i => md[`away_score_quarter${i}`]), hq: [1, 2, 3, 4].map(i => md[`home_score_quarter${i}`]),
                arec: md.away_record || null, hrec: md.home_record || null, spread: md.spread || null,
                weather: md.forecast_description || null, temp: md.forecast_temp_high ?? null, stadium: (md.stadium_details || {}).name || null,
                pos: md.possession || null, dd: md.down_and_distance || null, down: md.down || null, yl: md.yard_line ?? null, ylt: md.yard_line_territory || null, rz: !!md.red_zone };
            return rec;
}
// ── Sleeper's own socket ────────────────────────────────────────
// sleeper.com polls for nothing. Watched for 75 seconds on a matchup page it
// made no repeat request at all: everything live arrives over a Phoenix socket
// at gateway.sleeper.com, where it joins score:nfl for scoring and league:<id>
// for what the league does. So we join the same rooms, with the token the page
// keeps in localStorage, instead of asking the API the same question every minute.
//
// What those pushes carry is not relied on: on a day with no games score:nfl
// acknowledges the join and says nothing more. A push is therefore treated as
// a doorbell rather than a delivery: it triggers the fetches the timer would
// have made, throttled. Every frame is kept in a ring buffer, so a live Sunday
// shows what they carry — window.badgerLeagueWs() from the extension's console
// context.
const WS_URL = 'wss://gateway.sleeper.com/socket/websocket';
const WS_LOG = [];
let ws = null, wsBeat = null, wsRetry = 0, wsRetryTimer = null, wsLastMsg = 0;
// Heartbeat acks keep wsLastMsg fresh whether or not the rooms ever say
// anything, so the poll stands down on wsLastPush — a real push on a real
// topic. Until one arrives the minute cadence holds, which means a renamed or
// silent channel degrades to today's behaviour instead of to five minutes.
let wsLastPush = 0;
let wsPend = null, wsLastPull = 0, wsWant = { score: false, league: false };
const wsHealthy = () => !!ws && ws.readyState === 1;
function wsSend(frame) { try { if (wsHealthy()) ws.send(JSON.stringify(frame)); } catch (e) {} }
function wsConnect() {
    if (S.killed || ws) return;
    let tok = '';
    try { tok = (localStorage.getItem('token') || '').replace(/^"|"$/g, '').trim(); } catch (e) { /* no session */ }
    if (!tok) return;   // signed out: the poll carries it alone
    let sock;
    try { sock = new WebSocket(`${WS_URL}?token=${encodeURIComponent(tok)}&device_type=web&vsn=2.0.0`); } catch (e) { return; }
    // An extension reload or an SPA reinject leaves the previous copy's socket
    // running: it would keep pulling and re-rendering against a dead context.
    // Retire it before taking over.
    try { const prev = window.__badgerLeagueSock; if (prev && prev !== sock) prev.close(); } catch (e) {}
    window.__badgerLeagueSock = sock;
    ws = sock;
    sock.onopen = () => {
        if (sock !== ws || S.killed) { try { sock.close(); } catch (e) {} return; }
        wsRetry = 0; wsLastMsg = Date.now();
        wsSend([null, null, 'score:nfl', 'phx_join', {}]);
        wsSend([null, null, `league:${S.leagueId}`, 'phx_join', {}]);
        if (S.myUserId) wsSend([null, null, `user:${S.myUserId}`, 'phx_join', {}]);   // DMs and read receipts, as Sleeper's own client joins it
        wsBeat = setInterval(() => { if (sock === ws) wsSend([null, null, 'phoenix', 'heartbeat', {}]); }, 30000);
        console.log(TAG, `live socket open — score:nfl, league:${S.leagueId}`);
    };
    sock.onmessage = (e) => { if (sock !== ws || S.killed) return; wsLastMsg = Date.now(); wsFrame(e.data); };
    sock.onerror = () => { try { sock.close(); } catch (e) {} };
    sock.onclose = () => {
        if (sock !== ws) return;
        clearInterval(wsBeat); wsBeat = null; ws = null;
        if (S.killed) return;
        const wait = Math.min(60000, 3000 * Math.pow(2, wsRetry++));
        clearTimeout(wsRetryTimer); wsRetryTimer = setTimeout(wsConnect, wait);
    };
}
function wsFrame(raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(m) || m.length < 4) return;
    const topic = m[2], event = m[3];
    if (topic === 'phoenix' || /^phx_/.test(event)) return;   // acks and closes, not news
    wsLastPush = Date.now();
    if (WS_LOG.length < 300) WS_LOG.push({ t: Date.now(), topic, event, payload: m[4] });
    if (/^score:/.test(topic)) { if (!wsApply(event, m[4])) wsBump('score'); }
    else if (/^league:/.test(topic)) {
        const p = m[4];
        if (event === 'message_created' && p && p.message_id) {
            chatPush('league', p); chatRenderSoon();
            if (attType(p) === 'transactions') wsBump('league');   // a roster move said out loud is still a roster move
        } else if (event === 'message_deleted' && p && p.message_id) { chatDrop('league', p.message_id); chatRenderSoon(); }
        else if (event === 'message_updated' && p && p.message_id) { chatPush('league', p); chatRenderSoon(); }
        else wsBump('league');
    } else if (/^user:/.test(topic)) {
        const p = m[4];
        if (event === 'received_message' && p && p.message_id && p.parent_id) { chatPush(String(p.parent_id), p); chatRenderSoon(); }
        else if (event === 'read_receipt' && p && String(p.user_id || '') === String(S.myUserId) && p.parent_id && p.last_read_id) {
            const cid = String(p.parent_id) === String(S.leagueId) ? 'league' : String(p.parent_id);
            if (!S.chatRead[cid] || idGt(p.last_read_id, S.chatRead[cid])) S.chatRead[cid] = String(p.last_read_id);
            const c = convoOf(cid); if (c && (!c.last_read_id || idGt(p.last_read_id, c.last_read_id))) c.last_read_id = String(p.last_read_id);
            chatRenderSoon();
        }
    }
}
// A chat push renders quickly: a reply should not wait out the plays' 1.2s batch.
let chatRenderT = null;
function chatRenderSoon() { if (chatRenderT) return; chatRenderT = setTimeout(() => { chatRenderT = null; if (!S.killed) render(); }, 150); }
// ── the pushes themselves ───────────────────────────────────────────────────
// The first live Sunday settled what score:nfl carries: whole plays (new_play,
// updated_play — the same record the plays query returns, plus a play_id), a
// player's whole weekly stat line (stat_updated), and the game record
// (score_updated — quarter, clock, score, possession). That is the feed the
// site itself renders from, so it is applied straight into state: the stat
// line replaces his, the matchup his points sit in is re-summed, the play
// lands in the log, the game's clock moves — and only then is a render owed.
// The pull stands down to a safety net while pushes are landing. A push that
// cannot be applied returns false and rings the doorbell as before.
let wsRenderT = null, wsApplied = 0;
function wsRenderSoon() { if (wsRenderT) return; wsRenderT = setTimeout(() => { wsRenderT = null; if (!S.killed && !document.hidden) render(); }, 1200); }
function wsApply(event, p) {
    if (!p || String(p.week) !== String(S.week) || String(p.season) !== String(S.season) || S.fracDone) return false;
    try {
        if (event === 'stat_updated' && p.player_id && p.stats) {
            // only INTO a loaded map: seeding one from a push blocked the real pull
            // (loadStats returns when the map exists) and left every other player
            // with no line at all — the "(none)" Sunday
            const pid = String(p.player_id), pts = scoreStats(p.stats), m = S.stats[S.week];
            if (!m) return false;
            m[pid] = { pid, pts, opp: p.opponent, stats: p.stats };
            foldStanding(pid, p.player);
            statsGen++;
            // his points in the matchup he starts in, and that side's total, re-summed the way Sleeper sums it
            if (pts != null) for (const mu of S.matchups[S.week] || []) {
                if (!mu.players_points || !(pid in mu.players_points)) continue;
                mu.players_points[pid] = pts;
                const i = (mu.starters || []).indexOf(pid);
                if (i >= 0 && Array.isArray(mu.starters_points)) { mu.starters_points[i] = pts; mu.points = Math.round(mu.starters_points.reduce((t, v) => t + (v || 0), 0) * 100) / 100; }
            }
        } else if ((event === 'new_play' || event === 'updated_play') && p.game_id && p.metadata) {
            if (p.metadata.is_pulse) return true;   // "Play start" pulses carry nothing
            const rec = S.plays[S.week];
            if (!rec || !rec.list || !rec.list.length) return false;   // the first pull brings the week; pushes add to it
            if (rec.done) return true;
            const play = { play_id: p.play_id, time: p.time, game_id: p.game_id, metadata: p.metadata, play_stats: (p.play_stats || []).map(x => ({ player_id: x.player_id, stats: x.stats })) };
            const i = rec.list.findIndex(x => (play.play_id && x.play_id === play.play_id) || (!play.play_id && x.game_id === play.game_id && x.metadata && x.metadata.sequence === play.metadata.sequence));
            if (i >= 0) rec.list[i] = play; else { rec.list.push(play); if (rec.list.length > 1 && byPlayOrder(rec.list[rec.list.length - 2], play) > 0) rec.list.sort(byPlayOrder); }
            rec.at = Date.now();
        } else if (event === 'score_updated' && p.metadata) {
            const rec = kickRec(p); if (!rec) return false;
            if (S.kickWeek !== S.week) return false;   // the map on hand is another week's; the pull brings this one
            S.kick[rec.home] = rec; S.kick[rec.away] = rec;
            if (S.kickByWeek) S.kickByWeek[S.week] = S.kick;
        } else return false;
    } catch (e) { console.warn(TAG, 'ws apply:', e.message); return false; }
    wsApplied++; wsRenderSoon();
    return true;
}
// A burst of pushes is one refetch: coalesce, and never pull more than once
// every six seconds however loud the socket gets.
function wsBump(kind) {
    wsWant[kind] = true;
    if (wsPend) return;
    wsPend = setTimeout(() => {
        wsPend = null; wsLastPull = Date.now();
        const want = wsWant; wsWant = { score: false, league: false };
        wsPull(want).catch(e => console.warn(TAG, 'ws pull:', e.message));
    }, Math.max(400, (kind === 'score' && wsApplied ? 30000 : 6000) - (Date.now() - wsLastPull)));   // scores arrive by push now; the pull is the safety net
}
async function wsPull(want) {
    if (S.killed || document.hidden) return;   // visibilitychange catches us up
    if (want.league) {
        S.rosters = await rest(`${API}/league/${S.leagueId}/rosters`);
        S.myRoster = S.rosters.find(r => String(r.owner_id) === String(S.myUserId) || (r.co_owners || []).map(String).includes(String(S.myUserId))) || S.myRoster;
        S.txns[S.week] = null; S.waivers = null;
        S.matchups[lineupRound()] = null;   // the lineups live on this round's matchups
        await Promise.all([loadTxns(S.week), loadWaivers(), loadPending(), loadMatchups(lineupRound())]);
        syncLineups();
    }
    if (want.score) { S.matchups[S.week] = null; S.legs[S.week] = null; await Promise.all([loadMatchups(S.week), loadLegs(S.week), refreshLive()]); }
    render();
}

// ── keeping a live week live ─────────────────────────────────────────────────
// Rosters and matchups already refresh on the timer, but the stat lines and the
// game state behind a player's sub-line were loaded once at page open — so the
// points beside a name could move while "Q3 · 17-13 · 6 rec, 71 yds" stayed
// frozen. Both now refresh too, but only while something is actually kicking.
const liveWeek = () => S.seasonType === 'regular' && S.week === S.curWeek;
// How many NFL games of the current week are under way, whatever week is on
// screen: kicked off and not yet final. The Scoreboard link says LIVE while this
// is not zero.
function gamesLiveNow() {
    const m = (S.kickByWeek || {})[S.curWeek] || {}, on = new Set();
    for (const t in m) { const g = m[t]; if (g && !g.over && (g.live || g.started)) on.add(g.gid); }
    return on.size;
}
function gamesInProgress() {
    for (const t in (S.kick || {})) { const g = S.kick[t]; if (g && (g.live || (g.started && !g.over))) return true; }
    return false;
}
async function refreshLive() {
    // reading another week: the current one's games are still asked after, for the bar's LIVE mark
    if (!liveWeek()) { if (S.seasonType === 'regular' && !S.ui.vault && S.curWeek >= 1 && S.curWeek <= LAST_WEEK) await loadKickoffs(true, S.curWeek); return; }
    await loadKickoffs(true);          // cheap, and it is what tells us a game began
    // the morning after the week's last game moves the pages on, without a reload
    if (settleWeek()) { await ensureData(); return; }
    if (!gamesInProgress()) return;
    S.stats[S.week] = null;
    await Promise.all([loadStats(S.week), (S.page === 'matchup' || S.page === 'home') ? loadPlays(S.week).catch(() => {}) : null]);
    statsGen++;                        // stale ranks would otherwise survive the pull
}
function kickoffLabel(team) {
    const m = kickMap(), k = m && m[team]; if (!k) return null;
    const d = new Date(k.t);
    const hr = d.getHours() % 12 || 12, mn = String(d.getMinutes()).padStart(2, '0');
    return `${DAY[d.getDay()]} ${hr}:${mn}${d.getHours() < 12 ? 'a' : 'p'}`;
}

// ── the line under a player's name ───────────────────────────────────────────
// Before kickoff it is a schedule — when, who, how hard, where to watch. Once
// the ball is in the air it stops being a plan and becomes a box score.
function gamePhase(pid) {
    const k = insKickInfo(pid);
    // A week already behind us is final whether or not its kickoff map has
    // landed yet: for the first seconds on the Scoreboard's review week it has
    // not, and the rows read "Sun 10:00a" under a week that ended on Monday.
    if (!k) return S.week < S.curWeek && !S.fracDone ? 'final' : null;
    if (k.over || k.q === 'F' || /complete|closed/i.test(k.status || '')) return 'final';
    if (k.q === 'H' || (k.qn === 2 && k.tr === '00:00')) return 'half';
    if (k.live || k.started) return 'live';
    return Date.parse(k.t) < Date.now() ? 'live' : 'pre';
}
function quarterLabel(k) {
    if (!k) return 'LIVE';
    if (k.q === 'H') return 'HALF';
    if (k.q === 'OT' || k.qn > 4) return 'OT';
    if (k.qn) return `Q${k.qn}`;
    return /^\d$/.test(k.q || '') ? `Q${k.q}` : 'LIVE';
}
// A short live line, per position — enough to tell whether he is having a day.
function gameStatText(pid) { const a = gameStatAtoms(pid); return a ? a.join(', ') : null; }
function gameStatAtoms(pid, stats) {
    const line = stats ? { stats } : statLine(pid, 'wkActual'); if (!line || !line.stats) return null;
    const st = line.stats, pos = ppos(pid), n = (k) => st[k] || 0, out = [];
    if (pos === 'QB') {
        if (n('pass_att')) out.push(`${fmt0(n('pass_cmp'))}/${fmt0(n('pass_att'))}, ${fmt0(n('pass_yd'))} yds`);
        if (n('pass_td')) out.push(`${fmt0(n('pass_td'))} TD`);
        if (n('pass_int')) out.push(`${fmt0(n('pass_int'))} INT`);
        if (n('rush_yd')) out.push(`${fmt0(n('rush_yd'))} rush`);
    } else if (pos === 'RB') {
        if (n('rush_att')) out.push(`${fmt0(n('rush_att'))} car, ${fmt0(n('rush_yd'))} yds`);
        if (n('rec_tgt') || n('rec')) out.push(`${fmt0(n('rec'))}/${fmt0(Math.max(n('rec_tgt'), n('rec')))} rec, ${fmt0(n('rec_yd'))} yds`);   // catches over targets: a look is news before a catch is
        const td = n('rush_td') + n('rec_td'); if (td) out.push(td > 1 ? `${td} TD` : 'TD');
    } else if (pos === 'WR' || pos === 'TE') {
        out.push(`${fmt0(n('rec'))}/${fmt0(Math.max(n('rec_tgt'), n('rec')))} rec, ${fmt0(n('rec_yd'))} yds`);
        const td = n('rec_td') + n('rush_td'); if (td) out.push(td > 1 ? `${td} TD` : 'TD');
    } else if (pos === 'K') {
        if (n('fga')) out.push(`${fmt0(n('fgm'))}/${fmt0(n('fga'))} FG`);
        if (n('xpa')) out.push(`${fmt0(n('xpm'))}/${fmt0(n('xpa'))} XP`);
    } else if (pos === 'DEF') {
        if (n('sack')) out.push(`${fmt0(n('sack'))} sck`);
        if (n('int')) out.push(`${fmt0(n('int'))} INT`);
        if (st.pts_allow != null) out.push(`${fmt0(st.pts_allow)} pts alw`);
    }
    // Three clauses is the whole budget — the most telling ones come first.
    return out.length ? out.slice(0, 3) : null;
}
// Designations that mean he will not play. NA is deliberately absent: it means
// listed on the injury report with no game designation issued yet — the normal
// mid-week state, not a scratch.
const NO_PLAY_RE = /^(out|ir|pup|sus|cov|dnr)$/i;
const notPlaying = (pid) => { const s = statusOf(pid); return !!s && NO_PLAY_RE.test(s); };
// Ruled out, or Sleeper has him in the week's projections with nothing to give.
// That second test is what catches a player like an NA whose designation says
// nothing but whose projection says everything — it is a fact rather than a
// label, so it needs no argument about what NA means. Guarded on the pool
// having loaded, or every row would be a zero for a moment.
function willNotPlay(pid) {
    if (S.fracDone) return false;             // vault mode: he played or he didn't — the points say

    if (!pid || pid === '0') return false;
    if (notPlaying(pid)) return true;
    const pool = S.proj[S.week];
    return !!pool && Object.keys(pool).length > 50 && (projOf(pid, S.week) || 0) <= 0;
}
function gameSub(pid) {
    const pl = P(pid) || {}, g = gameOf(pid, S.week), k = insKickInfo(pid);
    const gid = ((kickMap() || {})[pl.team] || {}).gid;
    const sub = (...kids) => h('div', { class: `sub ${gid ? 'gamelink' : ''}`, title: gid ? 'Open this game in NFL games' : null, onclick: gid ? (e) => { e.stopPropagation(); S.ui.gcGame = gid; S.ui.muView = 'nfl'; S.ui.muPick = false; if (S.page !== 'matchup') go('matchup'); else render(); } : null }, ...kids.filter(x => x != null && x !== ''));
    if (isBye(pid, S.week)) return sub(h('span', { class: 'gs bye' }, 'BYE'), S.week < LAST_WEEK ? ` \u00b7 returns Week ${S.week + 1}` : null);
    const where = g ? `${g.home ? 'vs' : '@'} ${g.opp}` : '';
    const phase = gamePhase(pid), st = statusOf(pid);
    // A player who is not playing gets told so first; the game is context.
    if (st && NO_PLAY_RE.test(st) && (!phase || phase === 'pre')) {
        const rest = [pl.injury_body_part, [kickoffLabel(pl.team), where].filter(Boolean).join(' ')].filter(Boolean).join(' \u00b7 ');
        return sub(h('span', { class: 'gs out' }, st.toUpperCase()), rest ? ` \u00b7 ${rest}` : null);
    }
    // Two lines once the ball is in the air. The first is the game: quarter and
    // clock, the opponent, the score in grey with his team's side bold, and ON
    // FIELD while his unit is out there (the offence for a skill player, the
    // other side's offence for a defence). The second is his box score, each
    // stat kept whole so the line only ever breaks between them.
    const pos = ppos(pid);
    const atoms = () => { const a = gameStatAtoms(pid) || []; return a.length ? h('span', { class: 'gsline' }, ...a.flatMap((x, i) => [i ? ' ' : '', h('span', { class: 'gsa' }, `${i ? '\u00b7 ' : ''}${x}`)])) : null; };
    const scoreEl = () => { if (!k || k.hs == null || k.as == null || !pl.team) return null;
        const home = pl.team === k.home, mine = home ? k.hs : k.as, theirs = home ? k.as : k.hs;
        return h('span', { class: 'gsscore' }, ' ', h('b', null, String(mine)), '\u2013', String(theirs)); };
    // a kicker is on the field for a snap at a time — the tag would be noise on him
    const onField = k && k.pos && pos !== 'K' ? (pos === 'DEF' ? k.pos !== pl.team : k.pos === pl.team) : false;
    if (phase === 'live' || phase === 'half') return sub(h('span', { class: 'gsa' }, h('span', { class: 'gs live' }, `\u25cf ${quarterLabel(k)}${phase === 'live' && k && k.tr ? ' ' + k.tr.replace(/^0(\d:)/, '$1') : ''}`), where ? ` \u00b7 ${where}` : null, scoreEl(),
        onField ? h('span', { class: 'gs onf', title: pos === 'DEF' ? 'His defence is on the field' : 'His offence is on the field' }, '\u{1F3C8}') : null), atoms());
    if (phase === 'final') return sub(h('span', { class: 'gsa' }, h('span', { class: 'gs fin' }, 'FINAL'), where ? ` \u00b7 ${where}` : null, scoreEl()), atoms());
    const ko = kickoffLabel(pl.team) || (g ? DAY[new Date(g.date + 'T12:00:00').getDay()] : '');
    return sub([ko, where].filter(Boolean).join(' ') || '\u2014', oppRankEl(pid, S.week));
}

// ── opponent difficulty (Sleeper's fan_pts_allow_<pos>, ranked 1–32) ─────────
// 1st = fewest fantasy points allowed to that position (stingy, red);
// 32nd = most (generous, green). Weeks 1–3 rank on last season's totals.
async function loadDefRanks() {
    if (S.defRanks || S.defRanksLoading) return;
    S.defRanksLoading = true;
    try {
        const season = S.curWeek <= 3 ? String(Number(S.season) - 1) : S.season;
        const r = await fetch(`https://api.sleeper.com/stats/nfl/${season}?season_type=regular&position%5B%5D=DEF&_=${Date.now()}`);
        const rows = await r.json();
        const KEYS = { QB: 'fan_pts_allow_qb', RB: 'fan_pts_allow_rb', WR: 'fan_pts_allow_wr', TE: 'fan_pts_allow_te', K: 'fan_pts_allow_k', DEF: 'fan_pts_allow_def' };
        const ranks = {};
        for (const pos in KEYS) {
            const vals = (rows || []).map(x => ({ t: x.player_id, v: (x.stats || {})[KEYS[pos]] })).filter(x => x.t && x.v != null);
            if (vals.length < 20) continue;   // not enough of a season to rank on
            vals.sort((x, y) => x.v - y.v);
            ranks[pos] = {}; vals.forEach((x, i) => { ranks[pos][x.t] = i + 1; });
        }
        S.defRanks = ranks; S.defRanksSeason = season;
        render();
    } catch (e) { console.warn(TAG, 'defRanks:', e.message); S.defRanks = {}; }
    finally { S.defRanksLoading = false; }
}
function oppRankInfo(pid, week) {
    const g = gameOf(pid, week ?? S.week); if (!g || !S.defRanks) return null;
    const pos = ppos(pid);
    const rk = S.defRanks[pos] && S.defRanks[pos][g.opp]; if (!rk) return null;
    return { rank: rk, tier: rk <= 8 ? 'r0' : rk <= 12 ? 'a' : rk >= 25 ? 'g' : 'n', opp: g.opp, pos };
}
function oppRankEl(pid, week) {
    const i = oppRankInfo(pid, week); if (!i) return null;
    const word = i.rank <= 16 ? `${ordinal(i.rank)}-fewest` : `${ordinal(33 - i.rank)}-most`;
    return h('span', { class: `oprk ${i.tier}`, title: `${i.opp} allow the ${word} fantasy points to ${i.pos}s (${S.defRanksSeason} season)` }, ordinal(i.rank));
}

// ── the period cluster, one component for Players and Team ───────────────────
function periodCluster(opts) {
    const ui = S.ui;

    const scopeList = settleBasis(periodsFor(opts));
    const refresh = () => { render(); ensureData().then(render).catch(fail); };
    const pick = (scope, week) => { ui.pdOpen = false; ui.scope = scope; if (week != null) { S.ui.weekPicked = true; S.week = Math.max(1, Math.min(LAST_WEEK, week)); } refresh(); };
    const label = ui.scope === 'season' ? 'Season' : ui.scope === 'last4' ? 'Last 4 games' : `Week ${S.week}${S.week === S.curWeek ? ' · current' : ''}`;
    const mi = (txt, sub, on, disabled, fn) => h('div', { class: `mi ${on ? 'on' : ''} ${disabled ? 'off' : ''}`, onclick: disabled ? null : fn }, txt, h('span', { class: 'mono' }, sub || ''));
    const inSeason = S.seasonType === 'regular';
    const menu = ui.pdOpen ? h('div', { class: 'pdmenu', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'pdpin' },
            mi('Season', 'YTD · RoS', ui.scope === 'season', false, () => pick('season')),
            mi('Last 4 games', inSeason ? 'per game' : '—', ui.scope === 'last4', !inSeason, () => pick('last4')),
            mi('Last week', S.curWeek > 1 && inSeason ? `wk ${S.curWeek - 1}` : '—', ui.scope === 'weekly' && S.week === S.curWeek - 1, !(S.curWeek > 1 && inSeason), () => pick('weekly', S.curWeek - 1)),
            mi('Current week', `wk ${S.curWeek}`, ui.scope === 'weekly' && S.week === S.curWeek, false, () => pick('weekly', S.curWeek)),
            mi('Next week', S.curWeek < LAST_WEEK ? `wk ${S.curWeek + 1}` : '—', ui.scope === 'weekly' && S.week === S.curWeek + 1, !(S.curWeek < LAST_WEEK), () => pick('weekly', S.curWeek + 1))),
        h('div', { class: 'pdhd' }, 'ALL WEEKS'),
        h('div', { class: 'pdscroll' }, ...Array.from({ length: LAST_WEEK }, (_, i) => i + 1).map(w => mi(`Week ${w}`, w === S.curWeek ? 'current' : '', ui.scope === 'weekly' && S.week === w, false, () => pick('weekly', w))))) : null;
    const lensClick = (k) => {
        const wasUsage = /^usage/.test(ui.basis);
        ui.basis = k;
        // Usage opens on the last four games: one week of snaps is a sample, four
        // is a role, and the current week is empty until it is played. Only on the
        // way in — a period picked once inside Usage stays picked.
        if (/^usage/.test(k) && !wasUsage && inSeason) ui.scope = 'last4';

        refresh();
    };
    return h('div', { class: 'fgroup' }, h('span', { class: 'flab' }, 'View'),
        // A lens that has no meaning in this period but a period where it does
        // (Proj over the last four) stays live: the click moves the period there.
        // Dimmed and dead, it trapped anyone who opened Usage from Proj.
        h('div', { class: 'tabs' }, ...scopeList.map(([k, tt, tip, ok, jump]) => h('span', { class: `${k === ui.basis ? 'on' : ''} ${ok === false && !jump ? 'off' : ''}`, style: k === ui.basis ? 'background:var(--blue);border-color:var(--blue);color:#fff' : '', title: tip, onclick: () => { if (ok !== false) lensClick(k); else if (jump) { ui.scope = jump; lensClick(k); } } }, tt))),
        (() => {
            // Stepping a week is the commonest move in this picker, so it gets the
            // arrows the top bar's week control has. They only mean something on a
            // week: Season and Last 4 are not a place in a sequence.
            const weekly = ui.scope === 'weekly';
            const step = (d) => () => { if (!weekly) return; const w = S.week + d; if (w < 1 || w > LAST_WEEK) return; pick('weekly', w); };
            const arrow = (d, glyph, title) => h('button', { class: 'pstep', disabled: !weekly || S.week + d < 1 || S.week + d > LAST_WEEK, title: weekly ? title : 'Pick a week to step through', 'aria-label': title, onclick: step(d) }, glyph);
            return h('div', { class: 'pdd pwk', onclick: (e) => e.stopPropagation() },
                arrow(-1, '\u2039', 'Previous week'),
                h('button', { class: 'ddbtn', onclick: () => { ui.pdOpen = !ui.pdOpen; render(); } }, label, caret()),
                arrow(1, '\u203a', 'Next week'),
                menu);
        })());
}
// Team stat block: four generic columns, position-aware content.
const TEAM_STATS = {
    QB: [['pass_yd', 'Pa Yd'], ['pass_td', 'Pa TD'], ['rush_rec_yd', 'Ru+Re'], ['anytime_tds', 'TD']],
    RB: [['rush_yd', 'Ru Yd'], ['rec_yd', 'Re Yd'], ['rec_tgt', 'Tgt'], ['anytime_tds', 'TD']],
    WR: [['rec_tgt', 'Tgt'], ['rec', 'Rec'], ['rec_yd', 'Re Yd'], ['anytime_tds', 'TD']],
    TE: [['rec_tgt', 'Tgt'], ['rec', 'Rec'], ['rec_yd', 'Re Yd'], ['anytime_tds', 'TD']],
    K: [['fgm', 'FGM'], ['fga', 'FGA'], ['xpm', 'XPM'], [null, '']],
    DEF: [['sack', 'Sck'], ['int', 'INT'], ['fum_rec', 'FR'], ['td', 'TD']],
};
function teamStatCells(pid) {
    const pos = ppos(pid); const line = statLine(pid, S.ui.basis);
    const cols = TEAM_STATS[pos] || TEAM_STATS.WR;
    return cols.map(([k, lbl]) => h('td', { class: 'r mono dim', title: lbl }, k == null ? '' : (() => { let v = statVal(line, k); if (v == null && k === 'anytime_tds' && line && line.stats) v = (line.stats.rush_td || 0) + (line.stats.rec_td || 0) + (line.stats.pass_td != null && pos === 'QB' ? 0 : 0) || null; return v == null ? '—' : h('span', null, h('span', { class: 'dim', style: 'font-size:9px' }, lbl + ' '), h('span', { style: 'color:var(--ink-2)' }, Math.abs(v) < 10 ? fmt1(v) : fmt0(v))); })()));
}

// ── the trade overlay: targeted journey ─────────────────────────────────────
async function loadTradedPicks() {
    if (S.tradedPicks) return;
    try { const d = await gql('roster_draft_picks', `query roster_draft_picks { roster_draft_picks(league_id: "${S.leagueId}"){ roster_id season round owner_id previous_owner_id } }`); S.tradedPicks = d.roster_draft_picks || []; }
    catch (e) { S.tradedPicks = []; }
}
// A roster's tradable picks: next season, rounds 1..6, plus anything the
// traded-pick table says it holds; minus what it has sent away.
function picksOwnedBy(rid) {
    const season = String(Number(S.season) + 1);
    const rounds = Math.min(6, (S.league.settings || {}).draft_rounds || 6);
    const out = [];
    for (let r = 1; r <= rounds; r++) {
        const traded = (S.tradedPicks || []).find(p => p.season === season && p.round === r && p.roster_id === rid);
        if (!traded || traded.owner_id === rid) out.push({ season, round: r, roster_id: rid, owner_id: rid, previous_owner_id: rid });
    }
    for (const p of (S.tradedPicks || [])) if (p.owner_id === rid && p.roster_id !== rid && p.season >= S.season) out.push({ season: p.season, round: p.round, roster_id: p.roster_id, owner_id: rid, previous_owner_id: p.previous_owner_id });
    return out.sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round);
}
const pickKey = (p) => `${p.season}:${p.round}:${p.roster_id}`;
const pickName = (p) => { const from = rosterById(p.roster_id); return `${p.season} R${p.round}${p.roster_id !== p.owner_id || (from && from.roster_id !== p.owner_id) ? '' : ''}${from && p.roster_id !== (S.ui.trade && 0) ? '' : ''}`; };
function openTrade(partnerRid, targetPid) {
    if (!S.myRoster) { toast('You do not manage a team in this league', 'err'); return; }
    S.ui.trade = { partner: partnerRid || null, give: new Set(), get: new Set(targetPid ? [targetPid] : []), givePicks: new Set(), getPicks: new Set(), faabGive: 0, faabGet: 0, days: 2, sending: false };
    const was = S.ui.tx; S.ui.chat = false; S.ui.notes = false; S.ui.composer = null;
    S.ui.tx = Object.assign({ tab: 'trades', seenBefore: txSeenAt() }, was || {}, { view: 'trade', from: was ? (was.view === 'trade' ? was.from : was.view || 'list') : 'page' });
    loadTradedPicks().then(render); txLoad();
    render();
}
async function sendTrade() {
    const tr = S.ui.trade; const my = S.myRoster; const other = rosterById(tr.partner);
    const adds = {}, drops = {};
    for (const pid of tr.give) { adds[pid] = other.roster_id; drops[pid] = my.roster_id; }
    for (const pid of tr.get) { adds[pid] = my.roster_id; drops[pid] = other.roster_id; }
    const picks = [];
    for (const key of tr.givePicks) { const p = picksOwnedBy(my.roster_id).find(x => pickKey(x) === key); if (p) picks.push({ season: p.season, round: p.round, roster_id: p.roster_id, owner_id: other.roster_id, previous_owner_id: my.roster_id }); }
    for (const key of tr.getPicks) { const p = picksOwnedBy(other.roster_id).find(x => pickKey(x) === key); if (p) picks.push({ season: p.season, round: p.round, roster_id: p.roster_id, owner_id: my.roster_id, previous_owner_id: other.roster_id }); }
    const budget = [];
    if (tr.faabGive > 0) budget.push({ sender: my.roster_id, receiver: other.roster_id, amount: Math.round(tr.faabGive) });
    if (tr.faabGet > 0) budget.push({ sender: other.roster_id, receiver: my.roster_id, amount: Math.round(tr.faabGet) });
    const a = kv(adds), dr = kv(drops);
    const expires = Math.round(Date.now() / 1000) + tr.days * 86400;
    tr.sending = true; render();
    try {
        const d = await gql('propose_trade', `mutation propose_trade($k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]) { propose_trade(league_id: "${S.leagueId}", draft_picks: ${gqlList(picks)}, waiver_budget: ${gqlList(budget)}, expires_at: ${expires}, k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops){ transaction_id status } }`,
            { k_adds: a.keys, v_adds: a.values, k_drops: dr.keys, v_drops: dr.values });
        S.ui.trade = null;
        // back to the list, the offer on top, marked as just sent
        const id = d && d.propose_trade && d.propose_trade.transaction_id;
        if (S.ui.tx) Object.assign(S.ui.tx, { view: 'list', tab: 'trades', tpart: 'offers', justSent: id || null });
        toast(`Offer sent to ${teamName(other)}`, 'ok');
        await loadPending(); render();
    } catch (e) { tr.sending = false; render(); toast(e.message, 'err'); }
}
function tradeBody() {
    const tr = S.ui.trade; const my = S.myRoster;
    const partners = S.rosters.filter(r => r.roster_id !== my.roster_id);
    const other = tr.partner ? rosterById(tr.partner) : null;
    const wk = (pid) => projOf(pid, Math.max(S.week, S.curWeek)) || 0;
    const net = [...tr.get].reduce((t, p) => t + wk(p), 0) - [...tr.give].reduce((t, p) => t + wk(p), 0);
    const rosterCol = (R, giving) => {
        const set = giving ? tr.give : tr.get;
        const pset = giving ? tr.givePicks : tr.getPicks;
        const list = (R.players || []).slice().sort((a, b) => wk(b) - wk(a));
        return h('div', { class: 'tcol' },
            h('div', { class: 'twho' }, avatarEl(R, 'sm'), h('div', null, teamName(R), h('small', null, giving ? 'you send from here' : 'you receive from here')),
                !giving ? h('select', { class: 'sel', style: 'margin-left:auto', onchange: (e) => { tr.partner = Number(e.target.value); tr.get.clear(); tr.getPicks.clear(); tr.faabGet = 0; render(); } }, ...partners.map(P2 => h('option', { value: P2.roster_id, selected: P2.roster_id === R.roster_id }, teamName(P2)))) : null),
            h('div', { class: 'tlist' },
                ...list.map(pid => { const on = set.has(pid); const pl = P(pid) || {}; return h('div', { class: `prow ${on ? (giving ? 'sel-give' : 'sel-get') : ''}`, 'data-pid': pid, 'data-side': giving ? 'give' : 'get', onclick: () => { on ? set.delete(pid) : set.add(pid); render(); } },
                    h('span', { class: `pos txt ${pl.position}` }, posLabel(pl.position)), h('b', null, pname(pid)), h('span', { class: 'mono dim' }, `${pl.team || 'FA'}`), h('span', { class: 'pts mono' }, fmt1(wk(pid)))); }),
                h('div', { class: 'picksrow' }, ...picksOwnedBy(R.roster_id).map(p => { const key = pickKey(p); const on = pset.has(key); return h('div', { class: `prow ${on ? (giving ? 'sel-give' : 'sel-get') : ''}`, onclick: () => { on ? pset.delete(key) : pset.add(key); render(); } }, h('span', { class: 'mono dim' }, 'PICK'), h('b', null, `${p.season} R${p.round}`), p.roster_id !== R.roster_id ? h('span', { class: 'mono dim' }, `via ${teamName(rosterById(p.roster_id)).slice(0, 10)}`) : null); })),
                waiverInfo().faab ? h('div', { class: 'picksrow', style: 'display:flex;align-items:center;gap:8px' }, h('span', { class: 'mono dim', style: 'font-size:10.5px' }, 'FAAB'), h('input', { class: 'txt bid', type: 'number', min: 0, max: faabLeft(R), value: giving ? tr.faabGive : tr.faabGet, oninput: (e) => { if (giving) tr.faabGive = Number(e.target.value); else tr.faabGet = Number(e.target.value); } }), h('span', { class: 'dim', style: 'font-size:11px' }, `of $${faabLeft(R)}`)) : null));
    };
    const summarySide = (giving) => {
        const set = giving ? tr.give : tr.get, pset = giving ? tr.givePicks : tr.getPicks, faab = giving ? tr.faabGive : tr.faabGet;
        const bits = [...set].map(pid => (P(pid) || {}).last_name || pname(pid)).concat([...pset].map(k => { const [s, r] = k.split(':'); return `${s} R${r}`; }));
        if (faab > 0) bits.push(`$${Math.round(faab)} FAAB`);
        return bits.join(' · ') || h('span', { class: 'dim' }, 'nothing yet');
    };
    const ready = other && (tr.give.size + tr.get.size + tr.givePicks.size + tr.getPicks.size > 0 || tr.faabGive > 0 || tr.faabGet > 0);
    return h('div', { class: 'tdock' },
        other ? h('div', { class: 'dim', style: 'font-size:12px;margin-bottom:8px' }, 'Click players and picks to move them.') : null,
        other ? h('div', { class: 'tcols' }, rosterCol(my, true), rosterCol(other, false))
            : h('div', { style: 'padding:20px' }, h('div', { class: 'muted', style: 'margin-bottom:10px' }, 'Who are you trading with?'), h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' }, ...partners.map(P2 => h('button', { class: 'btn', 'data-rid': P2.roster_id, onclick: () => { tr.partner = P2.roster_id; loadTradedPicks().then(render); render(); } }, teamName(P2))))),
        other ? h('div', { class: 'tsummary' },
            h('div', null, h('b', { class: 'dim', style: 'font-size:10px;letter-spacing:.06em' }, 'YOU SEND'), h('div', { style: 'font-size:12.5px' }, summarySide(true))),
            h('div', { class: 'mono', style: 'text-align:center;font-size:12px' }, h('span', { class: 'dim' }, 'weekly proj'), h('div', { class: `delta ${net > 0 ? 'up' : net < 0 ? 'dn' : ''}` }, `${net > 0 ? '+' : ''}${fmt1(net)} you`)),
            h('div', { style: 'text-align:right' }, h('b', { class: 'dim', style: 'font-size:10px;letter-spacing:.06em' }, 'YOU RECEIVE'), h('div', { style: 'font-size:12.5px' }, summarySide(false)))) : null,
        other ? h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:10px' },
            h('span', { class: 'dim', style: 'font-size:12px' }, 'Expires in'),
            h('select', { class: 'sel', onchange: (e) => { tr.days = Number(e.target.value); } }, ...[1, 2, 3, 7].map(d => h('option', { value: d, selected: d === tr.days }, `${d} day${d > 1 ? 's' : ''}`))),
            h('button', { class: 'btn p', disabled: !ready || tr.sending, 'data-act': 'trade-send', onclick: sendTrade }, tr.sending ? 'Sending…' : 'Send offer'), h('button', { class: 'btn s', onclick: () => txBack((S.ui.tx || {}).from) }, 'Cancel')) : null);
}

boot();
})();
