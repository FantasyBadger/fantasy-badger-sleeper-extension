// Fantasy Badger's arithmetic, kept apart from the pages that draw it: live win
// probability, playoff seeding, the season played out to its end, the season
// sheet, and the best legal lineup. Pure functions over plain data: no network,
// no DOM, no storage. The manifest loads this file ahead of league.js, which
// reads all of it through the one global defined here, FBCalc.
globalThis.FBCalc = (() => {
    'use strict';

    // ── win probability ───────────────────────────────────────────────────────
    const WINPROB_MODEL_VERSION = 'winprob/1';
    const WINPROB_DEFAULTS = Object.freeze({
        k: 3.2139,
        eps: 0.005,
        settledSigma: 0.5
    });
    function erf(x) {
        const sign = x < 0 ? -1 : 1;
        x = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * x);
        const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return sign * y;
    }
    // How wide a result still is: k × √(projected points not yet played).
    function winProbSigma(unplayed, p = WINPROB_DEFAULTS) {
        return p.k * Math.sqrt(Math.max(0, unplayed));
    }
    // The chance a projected margin ends above zero, as a normal curve of that
    // width. With nothing left to play it is the result itself: 1, 0, or a half
    // for a tie.
    function winProbSig(margin, sigma, p = WINPROB_DEFAULTS) {
        if (!(sigma > p.settledSigma)) return margin > p.eps ? 1 : margin < -p.eps ? 0 : 0.5;
        return 0.5 * (1 + erf(margin / (sigma * Math.SQRT2)));
    }

    // ── playoff seeding ───────────────────────────────────────────────────────
    const winPct = (t) => {
        const g = t.w + t.l + t.t;
        return g ? (t.w + 0.5 * t.t) / g : 0;
    };
    // Teams in order by a chain of tiebreaks (win percentage, points for, head to
    // head). Teams still level on one key go on to the next.
    function chainSort(list, keys, h2h) {
        const rank = (group, ki) => {
            if (group.length <= 1 || ki >= keys.length) return group;
            const key = keys[ki];
            const scored = group.map((t) => {
                if (key === 'pf') return { t, v: t.pf };
                if (key !== 'h2h') return { t, v: winPct(t) };
                let w = 0, g = 0;
                for (const o of group) {
                    if (o === t) continue;
                    const r = h2h(t.rid, o.rid);
                    w += r[0];
                    g += r[0] + r[1];
                }
                return { t, v: g ? w / g : 0.5 };
            });
            scored.sort((a, b) => b.v - a.v);
            const out = [];
            for (let i = 0; i < scored.length; ) {
                let j = i;
                while (j + 1 < scored.length && Math.abs(scored[j + 1].v - scored[i].v) < 1e-9) j++;
                out.push(...rank(scored.slice(i, j + 1).map((x) => x.t), ki + 1));
                i = j + 1;
            }
            return out;
        };
        return rank(list.slice(), 0);
    }
    const byesOf = (rule) => Number(rule?.byes ?? 0);
    // Seat the playoff field. Each rule in the book takes its seats in turn, from
    // the teams not yet seated.
    function applyRules(book, teams, h2h, playoffTeams) {
        const remaining = new Set(teams.map((t) => t.rid));
        const seeds = [];
        const byes = Math.min(byesOf(book.seeds[0]), playoffTeams);
        for (let ri = 0; ri < book.seeds.length && seeds.length < playoffTeams; ri++) {
            const rule = book.seeds[ri];
            const pool = teams.filter((t) => remaining.has(t.rid));
            let picked;
            if (rule.take === 'division_winners') {
                const winChain = !rule.winner || rule.winner === 'sleeper_default' ? ['win_pct', 'pf'] : rule.winner;
                const divs = Array.from(new Set(pool.map((t) => t.division || 0))).filter((d) => d > 0).sort((a, b) => a - b);
                const winners = divs.map((d) => chainSort(pool.filter((t) => (t.division || 0) === d), winChain, h2h)[0]).filter(Boolean);
                picked = chainSort(winners, rule.order ?? [], h2h);
            } else {
                const chain = rule.take === 'most_pf' ? (rule.order ?? [])[0] === 'pf' ? rule.order : ['pf'].concat(rule.order ?? []) : rule.order ?? [];
                picked = chainSort(pool, chain, h2h).slice(0, rule.count || 0);
            }
            for (const t of picked) {
                if (seeds.length >= playoffTeams) break;
                seeds.push({ rid: t.rid, rule: ri });
                remaining.delete(t.rid);
            }
        }
        return { seeds, byes };
    }
    // The byes a field of that size needs to fill a bracket.
    function bracketByes(playoffTeams) {
        const n = playoffTeams ?? 0;
        if (n < 2) return 0;
        let p = 1;
        while (p < n) p *= 2;
        return p - n;
    }
    // Sleeper's seeding, written as a rulebook: division winners first when the
    // league has divisions, then the best records, ties on points for.
    function synthesizeSleeperDefault(facts) {
        const chain = ['win_pct', 'pf'];
        const seats = facts.playoffTeams ?? 6;
        const seeds = [];
        let remaining = seats;
        if (facts.divisions.length >= 2) {
            const byes = Math.min(bracketByes(seats), facts.divisions.length);
            seeds.push({
                take: 'division_winners',
                winner: 'sleeper_default',
                order: chain,
                ...byes > 0 ? { byes } : {}
            });
            remaining -= facts.divisions.length;
        }
        if (remaining > 0 || seeds.length === 0) {
            const byes = seeds.length === 0 ? bracketByes(seats) : 0;
            seeds.push({ take: 'best_record', count: Math.max(remaining, 1), order: chain, ...byes > 0 ? { byes } : {} });
        }
        return {
            version: 1,
            label: 'Sleeper default seeding',
            seeds,
            reseed: false,
            playoff_tie: ['pf']
        };
    }

    // ── the season, played out ────────────────────────────────────────────────
    const WP_K = WINPROB_DEFAULTS.k;
    const SIM_SEASONS = 3000;
    function rng(seed) {
        let a = seed >>> 0;
        return () => {
            a = a + 1831565813 >>> 0;
            let t = a;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    // The unplayed weeks, played out 3,000 times from a fixed seed. Each score is
    // drawn around the roster's projection; in the week under way, around what is
    // banked plus what is left. Every finished season is seated by the rulebook,
    // and the counts come back per team: in, bye, each seed, and what winning or
    // losing this week did to them.
    function simulateSeason(input) {
        const { rosterIds, division, games, book, playoffTeams } = input;
        const N = input.seasons ?? SIM_SEASONS;
        const rand = rng(input.seed ?? 20260901);
        let spare = null;
        const gauss = () => {
            if (spare != null) {
                const v2 = spare;
                spare = null;
                return v2;
            }
            let u = 0;
            while (!u) u = rand();
            const v = rand();
            const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
            spare = r * Math.sin(th);
            return r * Math.cos(th);
        };
        const finalSet = new Set(input.finalWeeks);
        const simWeeks = [];
        for (let w = 1; w <= input.regularSeasonWeeks; w++) if (!finalSet.has(w)) simWeeks.push(w);
        const cur = input.currentWeek;
        const base = new Map();
        for (const rid of rosterIds) base.set(rid, { rid, w: 0, l: 0, t: 0, pf: 0, division: division.get(rid) ?? 0 });
        const h2hBase = {};
        const hkey = (a, b) => `${a}:${b}`;
        for (const w of input.finalWeeks) for (const g of games.get(w) ?? []) {
            const A = base.get(g.a), B = base.get(g.b);
            if (!A || !B) continue;
            A.pf += g.pa;
            B.pf += g.pb;
            if (g.pa > g.pb) {
                A.w++;
                B.l++;
                h2hBase[hkey(g.a, g.b)] = (h2hBase[hkey(g.a, g.b)] ?? 0) + 1;
            } else if (g.pb > g.pa) {
                B.w++;
                A.l++;
                h2hBase[hkey(g.b, g.a)] = (h2hBase[hkey(g.b, g.a)] ?? 0) + 1;
            } else {
                A.t++;
                B.t++;
            }
        }
        const meanOf = (rid, w) => input.means.get(rid)?.get(w) ?? 0;
        const tally = new Map();
        for (const rid of rosterIds) tally.set(rid, { rid, n: 0, in_: 0, bye: 0, out: 0, seed: {}, route: {}, winIn: 0, winN: 0, loseIn: 0, loseN: 0, magic: null, wins: 0, pf: 0, byWins: {} });
        const curGame = new Map();
        for (const g of games.get(cur) ?? []) {
            curGame.set(g.a, g);
            curGame.set(g.b, g);
        }
        for (let s = 0; s < N; s++) {
            const t = new Map();
            for (const rid of rosterIds) t.set(rid, { ...base.get(rid) });
            const h2h = { ...h2hBase };
            const wins = new Map();
            const wonCur = new Map();
            for (const w of simWeeks) for (const g of games.get(w) ?? []) {
                const A = t.get(g.a), B = t.get(g.b);
                if (!A || !B) continue;
                const ma = meanOf(g.a, w), mb = meanOf(g.b, w);
                const za = gauss(), zb = gauss();
                let sa = ma + WP_K * Math.sqrt(Math.max(0, ma)) * za;
                let sb = mb + WP_K * Math.sqrt(Math.max(0, mb)) * zb;
                if (w === cur) {
                    const ca = input.currentPoints.get(g.a) ?? 0, cb = input.currentPoints.get(g.b) ?? 0;
                    const ra = input.currentRemaining?.get(g.a), rb = input.currentRemaining?.get(g.b);
                    if (ra != null) sa = ca + ra + WP_K * Math.sqrt(Math.max(0, ra)) * za;
                    if (rb != null) sb = cb + rb + WP_K * Math.sqrt(Math.max(0, rb)) * zb;
                    sa = Math.max(sa, ca);
                    sb = Math.max(sb, cb);
                }
                A.pf += sa;
                B.pf += sb;
                const aw = sa > sb;
                if (aw) {
                    A.w++;
                    B.l++;
                    h2h[hkey(g.a, g.b)] = (h2h[hkey(g.a, g.b)] ?? 0) + 1;
                } else {
                    B.w++;
                    A.l++;
                    h2h[hkey(g.b, g.a)] = (h2h[hkey(g.b, g.a)] ?? 0) + 1;
                }
                wins.set(aw ? g.a : g.b, (wins.get(aw ? g.a : g.b) ?? 0) + 1);
                if (w === cur) {
                    wonCur.set(g.a, aw);
                    wonCur.set(g.b, !aw);
                }
            }
            const res = applyRules(book, Array.from(t.values()), (a, b) => [h2h[hkey(a, b)] ?? 0, h2h[hkey(b, a)] ?? 0], playoffTeams);
            const seatOf = new Map();
            res.seeds.forEach((x, i) => seatOf.set(x.rid, i));
            for (const rid of rosterIds) {
                const T = tally.get(rid);
                const idx = seatOf.get(rid);
                const isIn = idx != null;
                T.n++;
                const fin = t.get(rid);
                T.wins += fin.w + 0.5 * fin.t;
                T.pf += fin.pf;
                if (isIn) {
                    T.in_++;
                    T.seed[idx + 1] = (T.seed[idx + 1] ?? 0) + 1;
                    const ri = res.seeds[idx].rule;
                    T.route[ri] = (T.route[ri] ?? 0) + 1;
                    if (idx < res.byes) T.bye++;
                } else T.out++;
                const wc = wonCur.get(rid);
                if (curGame.has(rid) && wc != null) {
                    if (wc) {
                        T.winN++;
                        if (isIn) T.winIn++;
                    } else {
                        T.loseN++;
                        if (isIn) T.loseIn++;
                    }
                }
                const k = wins.get(rid) ?? 0;
                const bw = T.byWins[k] = T.byWins[k] ?? { n: 0, in_: 0 };
                bw.n++;
                if (isIn) bw.in_++;
            }
        }
        const remaining = simWeeks.filter((w) => w >= cur).length;
        const teams = new Map();
        for (const rid of rosterIds) {
            const T = tally.get(rid);
            let magic = null;
            for (let k = 0; k <= remaining; k++) {
                let n2 = 0, in2 = 0;
                for (const kk of Object.keys(T.byWins)) if (Number(kk) >= k) {
                    n2 += T.byWins[Number(kk)].n;
                    in2 += T.byWins[Number(kk)].in_;
                }
                if (n2 >= 30 && in2 / n2 >= 0.99) {
                    magic = k;
                    break;
                }
            }
            const { byWins: _bw, ...rest } = T;
            void _bw;
            teams.set(rid, { ...rest, magic });
        }
        return { n: N, remaining, teams };
    }

    // ── the season sheet, and the best legal lineup ───────────────────────────
    const FLEXABLE = new Set(['RB', 'WR', 'TE']);
    // The lineup slots a position, or a comma-separated list of them, can fill.
    function eligOf(pos) {
        const parts = String(pos ?? '').split(',').map((p) => p.trim()).filter(Boolean);
        const s = new Set(parts);
        if (parts.some((p) => FLEXABLE.has(p))) s.add('FLX');
        if (parts.some((p) => p === 'QB' || FLEXABLE.has(p))) s.add('SFLX');
        return s;
    }
    // A league's starting slots, with every kind of flex reduced to FLX or SFLX.
    function slotsFromRosterPositions(rosterPositions) {
        const rp = rosterPositions ?? [];
        const slots = rp.filter((p) => !['BN', 'IR', 'TAXI'].includes(p)).map((p) => p === 'FLEX' || p === 'REC_FLEX' || p === 'WRRB_FLEX' ? 'FLX' : p === 'SUPER_FLEX' ? 'SFLX' : p);
        return slots.length ? slots : ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLX', 'FLX', 'K', 'DEF'];
    }
    // The most points those players could have scored in those slots. An exact
    // search over which slots are filled, so a flex is never spent on the wrong
    // player.
    function optimalLineup(players, slots) {
        const n = slots.length;
        if (!n) return 0;
        const full = 1 << n;
        const dp = new Array(full).fill(-1);
        dp[0] = 0;
        for (const p of players) {
            let mask = 0;
            for (let i = 0; i < n; i++) if (p.elig.has(slots[i])) mask |= 1 << i;
            if (!mask) continue;
            for (let m = full - 1; m >= 0; m--) {
                if (dp[m] < 0) continue;
                let a = mask & ~m;
                while (a) {
                    const bit = a & -a;
                    a ^= bit;
                    if (dp[m] + p.pts > dp[m | bit]) dp[m | bit] = dp[m] + p.pts;
                }
            }
        }
        return Math.max(0, ...dp);
    }
    const mean = (v) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    const pstdev = (v) => {
        if (v.length < 2) return 0;
        const m = mean(v);
        return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
    };
    const pct = (v, p) => {
        if (!v.length) return 0;
        const s = [...v].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
    };
    const ONE_SCORE = 10;
    // One row per team for the season so far: record, all-play record, luck,
    // schedule, how much of the best lineup was started, and the schedule still
    // to come.
    function computeSeasonSheet(input) {
        const { rosterIds, slots, positionOf } = input;
        const division = input.division ?? {};
        const weeks = Object.keys(input.weeks).map(Number).filter((w) => Number.isFinite(w) && (input.weeks[w] ?? []).length > 0).sort((a, b) => a - b);
        const R = new Map();
        for (const rid of rosterIds) {
            R.set(rid, {
                rosterId: rid,
                games: 0,
                wins: 0,
                losses: 0,
                ties: 0,
                div: { wins: 0, losses: 0, ties: 0 },
                pointsFor: 0,
                pointsAgainst: 0,
                allPlayW: 0,
                allPlayL: 0,
                allPlayPct: 0,
                luck: 0,
                medianLuck: 0,
                schedulePoints: 0,
                oneScoreW: 0,
                oneScoreL: 0,
                weeklyHighs: 0,
                unluckiest: null,
                scores: [],
                results: [],
                mean: 0,
                sd: 0,
                floor: 0,
                ceiling: 0,
                optimalPoints: 0,
                benchLost: 0,
                efficiency: 1,
                perfectWeeks: 0,
                selfInflicted: 0,
                benchWeeks: [],
                adds: 0,
                failedBids: 0,
                faabSpent: 0,
                avgBid: null,
                addPoints: 0,
                waiverRoi: null,
                draftPoints: 0,
                draftShare: 0,
                sosRemaining: null,
                odds: input.odds?.[rid] ?? null
            });
        }
        const elig = new Map();
        const eligFor = (pid) => {
            let e = elig.get(pid);
            if (!e) {
                e = eligOf(positionOf[pid] ?? null);
                elig.set(pid, e);
            }
            return e;
        };
        const opt = new Map();
        const bids = new Map(rosterIds.map((r) => [r, []]));
        for (const w of weeks) {
            const rows2 = (input.weeks[w] ?? []).filter((r) => r.matchupId != null && R.has(r.rosterId));
            if (!rows2.length) continue;
            const pts = new Map(rows2.map((r) => [r.rosterId, r.points ?? 0]));
            const scores = Array.from(pts.values());
            const high = Math.max(...scores);
            const sorted = [...scores].sort((a, b) => a - b);
            const mid = sorted.length / 2;
            const median = sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
            for (const r of rows2) {
                const players = (r.players?.length ? r.players : Object.keys(r.playerPoints ?? {})).filter((pid) => (r.playerPoints ?? {})[pid] != null).map((pid) => ({ pts: r.playerPoints[pid] ?? 0, elig: eligFor(pid) }));
                opt.set(`${w}:${r.rosterId}`, Math.max(optimalLineup(players, slots), r.points ?? 0));
            }
            const byMatchup = new Map();
            for (const r of rows2) {
                const list = byMatchup.get(r.matchupId) ?? [];
                list.push(r);
                byMatchup.set(r.matchupId, list);
            }
            for (const pair of Array.from(byMatchup.values())) {
                if (pair.length !== 2) continue;
                const [a, b] = pair;
                const pa = pts.get(a.rosterId) ?? 0, pb = pts.get(b.rosterId) ?? 0;
                const sameDiv = !!division[a.rosterId] && division[a.rosterId] === division[b.rosterId];
                const margin = Math.abs(pa - pb);
                for (const [x, y, px, py] of [[a, b, pa, pb], [b, a, pb, pa]]) {
                    const t = R.get(x.rosterId);
                    t.games++;
                    t.pointsAgainst += py;
                    if (px > py) {
                        t.wins++;
                        t.results.push('W');
                        if (sameDiv) t.div.wins++;
                        if (margin < ONE_SCORE) t.oneScoreW++;
                    } else if (px < py) {
                        t.losses++;
                        t.results.push('L');
                        if (sameDiv) t.div.losses++;
                        if (margin < ONE_SCORE) t.oneScoreL++;
                        if (!t.unluckiest || px > t.unluckiest.points) {
                            t.unluckiest = { week: w, points: px, oppPoints: py, oppRosterId: y.rosterId };
                        }
                        if ((opt.get(`${w}:${x.rosterId}`) ?? 0) > py) t.selfInflicted++;
                    } else {
                        t.ties++;
                        t.results.push('T');
                        if (sameDiv) t.div.ties++;
                    }
                    if (px < py && px > median) t.medianLuck -= 1;
                    else if (px > py && px < median) t.medianLuck += 1;
                }
            }
            for (const r of rows2) {
                const t = R.get(r.rosterId);
                const p = pts.get(r.rosterId) ?? 0;
                t.pointsFor += p;
                t.scores.push(p);
                if (p === high) t.weeklyHighs++;
                for (const o2 of rows2) {
                    if (o2.rosterId === r.rosterId) continue;
                    const q = pts.get(o2.rosterId) ?? 0;
                    if (p > q) t.allPlayW++;
                    else if (p < q) t.allPlayL++;
                    else {
                        t.allPlayW += 0.5;
                        t.allPlayL += 0.5;
                    }
                }
                const o = opt.get(`${w}:${r.rosterId}`) ?? p;
                t.optimalPoints += o;
                const lost = Math.max(0, o - p);
                t.benchLost += lost;
                if (lost < 0.05) t.perfectWeeks++;
                else {
                    const started = new Set((r.starters ?? []).filter((x) => x && x !== '0'));
                    let sat = null, satPts = -Infinity;
                    for (const pid of r.players ?? []) {
                        if (started.has(pid)) continue;
                        const v = (r.playerPoints ?? {})[pid];
                        if (v != null && v > satPts) {
                            satPts = v;
                            sat = pid;
                        }
                    }
                    t.benchWeeks.push({ week: w, lost, sat, satPts: sat ? satPts : 0 });
                }
            }
        }
        const startedAfter = (rid, pid, fromWeek) => {
            let sum = 0;
            for (const w of weeks) {
                if (w < fromWeek) continue;
                const row = (input.weeks[w] ?? []).find((r) => r.rosterId === rid);
                if (!row || !(row.starters ?? []).includes(pid)) continue;
                sum += (row.playerPoints ?? {})[pid] ?? 0;
            }
            return sum;
        };
        for (const tx of input.transactions ?? []) {
            const rid = (tx.rosterIds ?? [])[0];
            const t = rid != null ? R.get(rid) : void 0;
            if (!t) continue;
            const isClaim = tx.type === 'waiver' || tx.type === 'free_agent';
            if (!isClaim) continue;
            if (tx.status !== 'complete') {
                if (tx.type === 'waiver') {
                    t.failedBids++;
                    if (tx.bid != null) bids.get(rid).push(tx.bid);
                }
                continue;
            }
            if (tx.bid != null) {
                t.faabSpent += tx.bid;
                bids.get(rid).push(tx.bid);
            }
            for (const pid of Object.keys(tx.adds ?? {})) {
                t.adds++;
                t.addPoints += startedAfter(rid, pid, tx.week);
            }
        }
        for (const pick of input.draftPicks ?? []) {
            const t = R.get(pick.rosterId);
            if (!t || !pick.playerId) continue;
            t.draftPoints += startedAfter(pick.rosterId, pick.playerId, weeks[0] ?? 1);
        }
        const leaguePA = mean(Array.from(R.values()).map((t) => t.pointsAgainst));
        for (const t of Array.from(R.values())) {
            const apG = t.allPlayW + t.allPlayL;
            t.allPlayPct = apG ? t.allPlayW / apG : 0;
            t.luck = t.wins + 0.5 * t.ties - t.allPlayPct * t.games;
            t.schedulePoints = t.pointsAgainst - leaguePA;
            t.mean = mean(t.scores);
            t.sd = pstdev(t.scores);
            t.floor = pct(t.scores, 0.15);
            t.ceiling = pct(t.scores, 0.85);
            t.efficiency = t.optimalPoints > 0 ? t.pointsFor / t.optimalPoints : 1;
            t.benchWeeks.sort((a, b) => b.lost - a.lost);
            t.benchWeeks = t.benchWeeks.slice(0, 3);
            const bb = bids.get(t.rosterId) ?? [];
            t.avgBid = bb.length ? mean(bb) : null;
            t.waiverRoi = t.faabSpent > 0 && t.addPoints > 0 ? t.faabSpent / t.addPoints : null;
            t.draftShare = t.pointsFor > 0 ? t.draftPoints / t.pointsFor : 0;
        }
        if (input.futureGames?.length) {
            const left = new Map(rosterIds.map((r) => [r, []]));
            for (const g of input.futureGames) {
                if (R.has(g.a) && R.has(g.b)) {
                    left.get(g.a).push(R.get(g.b).allPlayPct);
                    left.get(g.b).push(R.get(g.a).allPlayPct);
                }
            }
            for (const t of Array.from(R.values())) {
                const v = left.get(t.rosterId) ?? [];
                t.sosRemaining = v.length ? mean(v) : null;
            }
        }
        const rows = Array.from(R.values()).sort(
            (a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor
        );
        const n = weeks.length;
        const thin = { luck: n < 4, manager: n < 4, shape: n < 3 };
        return { weeks, rows, verdicts: verdictsFor(rows, thin), thin };
    }
    // The labels a season earns, each with a weight to rank it by.
    function verdictsFor(rows, thin) {
        if (!rows.length) return [];
        const out = [];
        const add = (key, rosterId, label, weight) => out.push({ key, rosterId, label, weight });
        const best = (list, score) => list.reduce((a, b) => score(b) > score(a) ? b : a, list[0]);
        const byWinPct = [...rows].sort((a, b) => b.wins - b.losses - (a.wins - a.losses));
        if (!thin.luck) {
            const ap = best(rows, (t) => t.allPlayPct);
            if (ap && byWinPct[0] && ap.rosterId !== byWinPct[0].rosterId) {
                add('paperChampion', ap.rosterId, 'Paper champion', 90);
            }
            for (const t of rows) {
                if (t.luck >= 2) add('highwire', t.rosterId, 'Highwire', 70 + t.luck * 5);
                if (t.luck <= -2) add('robbed', t.rosterId, 'Robbed', 70 - t.luck * 5);
                if (t.oneScoreL >= 3 && t.oneScoreW === 0) add('robbed', t.rosterId, 'Robbed', 80 + t.oneScoreL * 4);
                if (t.schedulePoints >= 120) add('gauntlet', t.rosterId, 'The gauntlet', 60 + t.schedulePoints / 10);
                if (t.schedulePoints <= -120) add('freeRide', t.rosterId, 'Free ride', 60 - t.schedulePoints / 10);
            }
        }
        if (!thin.shape) {
            const sds = rows.map((t) => t.sd).sort((a, b) => a - b);
            const loSd = sds[Math.floor(sds.length * 0.15)] ?? 0;
            const hiSd = sds[Math.ceil(sds.length * 0.85) - 1] ?? Infinity;
            for (const t of rows) {
                if (t.sd >= hiSd && t.sd > 0) add('boomBust', t.rosterId, "Boom\u2013bust", 55 + t.sd);
                if (t.sd <= loSd && t.sd > 0) add('metronome', t.rosterId, 'Metronome', 55 + (30 - t.sd));
            }
            const ceil = best(rows, (t) => t.ceiling);
            const others = rows.filter((t) => t.rosterId !== ceil.rosterId).map((t) => t.ceiling);
            if (others.length && ceil.ceiling - Math.max(...others) >= 12) {
                add('theCeiling', ceil.rosterId, 'The ceiling', 65);
            }
        }
        if (!thin.manager) {
            for (const t of rows) {
                if (t.selfInflicted >= 3) add('selfInflicted', t.rosterId, 'Self-inflicted', 85 + t.selfInflicted * 4);
                if (t.failedBids >= 20) add('triggerHappy', t.rosterId, 'Trigger happy', 50 + t.failedBids);
                if (t.adds <= 12 && t.allPlayPct >= 0.6) add('oneAndDone', t.rosterId, 'One and done', 55);
                if (t.perfectWeeks >= 3 && t.wins < t.losses) add('perfectPointless', t.rosterId, 'Perfect, pointless', 60);
            }
        }
        const bestPer = new Map();
        for (const v of out) {
            const cur = bestPer.get(v.rosterId);
            if (!cur || v.weight > cur.weight) bestPer.set(v.rosterId, v);
        }
        return Array.from(bestPer.values()).sort((a, b) => b.weight - a.weight);
    }

    return {
        WINPROB_DEFAULTS,
        WINPROB_MODEL_VERSION,
        applyRules,
        computeSeasonSheet,
        eligOf,
        optimalLineup,
        simulateSeason,
        slotsFromRosterPositions,
        synthesizeSleeperDefault,
        winProbSig,
        winProbSigma,
    };
})();
