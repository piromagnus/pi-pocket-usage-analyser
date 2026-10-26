// Usage analyser core: reads every model request of every session from Pi Pocket's store, keeps a compact
// incremental cache, and turns it into a report: tokens, cost by token type, cache hit rate, where the time went,
// and findings that say what to change. Pi Pocket's module runs this file as a child process and reads its JSON.
//
//   node analyse.mjs [--days 30 | --all] [--json] [--full] [--db <pocket.sqlite>] [--cache <cache.json>]
//
// Only token counts, timings, tool names and result sizes are kept. No message text.
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const MIN = 60e3;
/** Anthropic's default cache lifetime, and its long one. */
const TTL_SHORT = 5 * MIN;
const TTL_LONG = 60 * MIN;
/** Context size above which a long history is called bloat. */
const CONTEXT_TARGET = 60_000;

const TIPS = {
    idle: ["Cache expired during pauses", "Compact or start a fresh session before a long break. Use the 1-hour cache where the provider has it."],
    model: ["Model switched mid-session", "A switch re-sends the whole context uncached. Pick the model at the start, or hand side work to a subagent."],
    other: ["Unexplained cache breaks", "The cached prefix changed with no pause, compaction or model switch. Look for tools, memory or prompt parts that change mid-session."],
    bloat: ["Context grows past 60k", "Most of the cost is re-reading a long history. Compact earlier, split into fresh sessions, give exploration to subagents."],
    tools: ["Large tool results stay in context", "Every later request re-reads them. Read ranges, grep or head, filter in a batch tool, or use a subagent for wide searches."],
    light: ["Priciest model on routine steps", "Many short tool-call steps ran on a pricier model. Run exploration in subagents on a cheaper model."],
    think: ["Heavy thinking", "Reasoning tokens dominate output. Lower the thinking level for routine edits."],
    loop: ["Long tool loops", "Many requests per prompt, each re-reading the context. Batch with codemode or parallel calls, and give sharper prompts."],
};

// ——— the store → a compact cache ———

export const emptyCache = () => ({ version: VERSION, lastEntry: 0, lastConv: 0, owners: {}, events: [] });

export async function loadCache(path) {
    try {
        const cache = JSON.parse(await readFile(path, "utf8"));

        return cache?.version === VERSION && Array.isArray(cache.events) ? cache : emptyCache();
    } catch {
        return emptyCache();
    }
}

async function saveCache(path, cache) {
    const temporary = `${path}.${process.pid}.tmp`;

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
    await rename(temporary, path);
}

const SQL = `
select id, conversation_id as c, k,
    case when k = 'pi.tool-result' then null else record end as rec,
    case when k = 'pi.tool-result' then json_extract(record, '$.model[0].toolName') end as tn,
    case when k = 'pi.tool-result' then json_extract(record, '$.model[0].timestamp') end as tt,
    case when k = 'pi.tool-result' then length(json_extract(record, '$.model[0].content')) end as tl,
    case when k = 'pi.tool-result' then json_extract(record, '$.model[0].isError') end as te
from (select id, conversation_id, record, json_extract(record, '$.kind') as k from entries where id > ? and id <= ?)
where k in ('pi.assistant', 'pi.user', 'pi.compaction', 'pi.tool-result')
order by id`;

/** Adds the entries newer than `cache.lastEntry` to the cache. Event kinds: r request, t tool result, u user turn, c compaction. */
export function scrape(dbPath, cache) {
    const db = new DatabaseSync(dbPath, { readOnly: true });

    try {
        const [{ top }] = db.prepare("select coalesce(max(id), 0) as top from entries").all();

        const stmt = db.prepare(SQL);
        const rows = function* () {
            // In windows of entries: `iterate` with bound values is not reliable on every Node 22/23.
            for (let from = cache.lastEntry; from < top; from += 5000) {
                yield* stmt.all(from, Math.min(top, from + 5000));
            }
        };

        for (const row of rows()) {
            if (row.k === "pi.tool-result") {
                cache.events.push({ k: "t", e: row.id, c: row.c, at: row.tt ?? 0, n: row.tn ?? "?", ch: row.tl ?? 0, er: row.te ? 1 : 0 });
                continue;
            }

            const messages = JSON.parse(row.rec)?.model;

            for (const m of Array.isArray(messages) ? messages : []) {
                if (row.k === "pi.assistant") {
                    const u = m?.usage;

                    if (!u || typeof m.timestamp !== "number") {
                        continue;
                    }

                    const s = m.pocketTiming?.startedAt ?? m.timestamp;

                    cache.events.push({
                        k: "r", e: row.id, c: row.c, s,
                        d: m.durationMs ?? (m.pocketTiming?.endedAt ? m.pocketTiming.endedAt - s : 0),
                        ti: u.input ?? 0, tr: u.cacheRead ?? 0, tw: u.cacheWrite ?? 0, to: u.output ?? 0, w1: u.cacheWrite1h ?? 0, rs: u.reasoning ?? 0,
                        ci: u.cost?.input ?? 0, cr: u.cost?.cacheRead ?? 0, cw: u.cost?.cacheWrite ?? 0, co: u.cost?.output ?? 0,
                        m: m.model ?? "?", p: m.provider ?? "?", x: m.stopReason ?? "", th: m.providerThinkingLevel ?? "", id: m.responseId,
                    });
                } else {
                    cache.events.push({ k: row.k === "pi.user" ? "u" : "c", e: row.id, c: row.c, at: m?.timestamp ?? 0 });
                }

                break;
            }
        }

        cache.lastEntry = top;

        for (const { id, o } of db
            .prepare("select id, json_extract(record, '$.owner.conversationId') as o from conversations where id > ?")
            .all(cache.lastConv)) {
            cache.lastConv = Math.max(cache.lastConv, id);

            if (o != null) {
                cache.owners[id] = o;
            }
        }
    } finally {
        db.close();
    }

    return cache;
}

/** The cache brought up to date and saved; `full` rebuilds it from every entry. */
export async function refresh(dbPath, cachePath, full = false) {
    const cache = scrape(dbPath, full ? emptyCache() : await loadCache(cachePath));

    await saveCache(cachePath, cache);

    return cache;
}

// ——— the cache → a report ———

const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const cost = (r) => r.ci + r.cr + r.cw + r.co;
const day = (ms) => new Date(ms).toLocaleDateString("sv");

/** Merged length of [start, end] intervals. */
function union(spans) {
    let total = 0;
    let end = -Infinity;

    for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
        total += Math.max(0, b - Math.max(a, end));
        end = Math.max(end, b);
    }

    return total;
}

export function analyse(cache, { since = 0 } = {}) {
    // Forks copy history into new conversations: keep the first copy of each event.
    const seen = new Set();
    const events = cache.events.filter((ev) => {
        const key = ev.k === "r" ? `r${ev.id ?? `${ev.c}:${ev.s}`}` : ev.k === "t" ? `t${ev.at}:${ev.n}:${ev.ch}` : `${ev.k}${ev.at || ev.e}`;

        return !seen.has(key) && seen.add(key);
    });
    const root = (c) => {
        for (let n = 0; cache.owners[c] != null && n < 20; n++) {
            c = cache.owners[c];
        }

        return c;
    };
    const inRange = (ms) => ms >= since;

    // Prices per token, learned from the requests themselves.
    const prices = {};

    for (const ev of events) {
        if (ev.k === "r") {
            const p = (prices[ev.m] ??= { tr: 0, cr: 0, to: 0, co: 0 });

            p.tr += ev.tr;
            p.cr += ev.cr;
            p.to += ev.to;
            p.co += ev.co;
        }
    }

    // Many older requests carry no duration: estimate it from the output tokens, at the model's own pace.
    const pace = {};
    let paceAll = { d: 0, to: 0 };

    for (const ev of events) {
        if (ev.k === "r" && ev.d > 0 && ev.to > 0) {
            const q = (pace[ev.m] ??= { d: 0, to: 0 });

            q.d += ev.d; q.to += ev.to; paceAll.d += ev.d; paceAll.to += ev.to;
        }
    }

    const duration = (ev) => {
        const q = pace[ev.m] ?? paceAll;

        return ev.d > 0 ? ev.d : Math.min(10 * MIN, q.to ? (ev.to * q.d) / q.to : 0);
    };
    const readPrice = (m) => (prices[m]?.tr ? prices[m].cr / prices[m].tr : 0);
    const outPrice = (m) => (prices[m]?.to ? prices[m].co / prices[m].to : 0);
    const cheapest = Math.min(
        ...Object.keys(prices)
            .filter((m) => prices[m].to > 20_000 && outPrice(m) > 0)
            .map(outPrice),
    );

    const byConv = new Map();

    for (const ev of events) {
        if (!byConv.has(ev.c)) {
            byConv.set(ev.c, []);
        }

        byConv.get(ev.c).push(ev);
    }

    const sessions = new Map();
    const session = (id) => {
        if (!sessions.has(id)) {
            sessions.set(id, {
                id, cost: 0, sub: 0, req: 0, main: 0, turns: 0, first: Infinity, last: 0, modelMs: 0, toolMs: 0, spans: [],
                t: { i: 0, r: 0, w: 0, o: 0 }, c: { i: 0, r: 0, w: 0, o: 0 }, peak: 0, ctxSum: 0, excess: 0,
                brk: { idle: { n: 0, lost: 0 }, model: { n: 0, lost: 0 }, other: { n: 0, lost: 0 }, compaction: { n: 0, lost: 0 } },
                est: 0, light: 0, lightModel: "", rsCost: 0, rs: 0, out: 0, models: {}, tools: {},
            });
        }

        return sessions.get(id);
    };
    const models = {};
    const days = {};
    const tools = {};
    const tool = (o, n) => (o[n] ??= { n, calls: 0, errs: 0, tokens: 0, ms: 0, carry: 0 });

    for (const [c, list] of byConv) {
        const rt = root(c);
        let prev = null;
        let prevEnd = 0;
        let ttl = TTL_SHORT;
        let compacted = false;

        for (let i = 0; i < list.length; i++) {
            const ev = list[i];

            if (ev.k === "c") {
                compacted = true;
            } else if (ev.k === "u") {
                if (c === rt && inRange(ev.at)) {
                    session(rt).turns++;
                }
            } else if (ev.k === "r") {
                const d = duration(ev);
                const end = ev.s + d;
                let toolsEnd = end;
                let lastTool = null;

                for (let j = i + 1; j < list.length && list[j].k === "t"; j++) {
                    if (list[j].at >= toolsEnd) {
                        toolsEnd = list[j].at;
                        lastTool = list[j];
                    }
                }

                const ctx = ev.ti + ev.tr + ev.tw;
                const wanted = inRange(ev.s);

                if (wanted) {
                    const S = session(rt);
                    const total = cost(ev);
                    const M = (models[ev.m] ??= { m: ev.m, p: ev.p, cost: 0, req: 0, ctx: 0, tr: 0, to: 0 });
                    const D = (days[day(ev.s)] ??= { d: day(ev.s), cost: 0, req: 0 });

                    S.cost += total;
                    S.sub += c === rt ? 0 : total;
                    S.req++;
                    S.main += c === rt ? 1 : 0;
                    S.first = Math.min(S.first, ev.s);
                    S.last = Math.max(S.last, toolsEnd);
                    S.modelMs += d;
                    S.est += ev.d > 0 ? 0 : 1;
                    S.toolMs += toolsEnd - end;
                    S.spans.push([ev.s, end], [end, toolsEnd]);
                    S.t.i += ev.ti; S.t.r += ev.tr; S.t.w += ev.tw; S.t.o += ev.to;
                    S.c.i += ev.ci; S.c.r += ev.cr; S.c.w += ev.cw; S.c.o += ev.co;
                    S.peak = Math.max(S.peak, ctx);
                    S.ctxSum += ctx;
                    S.excess += ctx > CONTEXT_TARGET ? ev.cr * (1 - CONTEXT_TARGET / ctx) : 0;
                    S.rs += ev.rs;
                    S.out += ev.to;
                    S.rsCost += ev.rs * outPrice(ev.m);
                    S.models[ev.m] = (S.models[ev.m] ?? 0) + total;

                    if (ev.x === "toolUse" && ev.to < 300 && outPrice(ev.m) >= 2 * cheapest) {
                        S.light += total;
                        S.lightModel = ev.m;
                    }

                    M.cost += total; M.req++; M.ctx += ctx; M.tr += ev.tr; M.to += ev.to;
                    D.cost += total; D.req++;

                    if (lastTool) {
                        tool(tools, lastTool.n).ms += toolsEnd - end;
                    }

                    if (prev) {
                        const prevCtx = prev.ti + prev.tr + prev.tw;

                        if (prevCtx >= 8000 && ev.tr < prevCtx * 0.5) {
                            const cause = ev.s - prevEnd > ttl ? "idle" : compacted ? "compaction" : ev.m !== prev.m ? "model" : "other";
                            const fresh = ev.ti + ev.tw;
                            const paid = (ev.ci + ev.cw) / (fresh || 1);
                            const lost = cause === "compaction" ? 0 : Math.max(0, Math.min(prevCtx, fresh) * (paid - readPrice(ev.m)));

                            S.brk[cause].n++;
                            S.brk[cause].lost += lost;
                        }
                    }
                }

                compacted = false;
                ttl = ev.w1 > 0 ? TTL_LONG : ttl;
                prev = ev;
                prevEnd = toolsEnd;
            }
        }

        // Backward: a tool result is re-read by every later request until the next compaction.
        let reread = 0;

        for (let i = list.length - 1; i >= 0; i--) {
            const ev = list[i];

            if (ev.k === "c") {
                reread = 0;
            } else if (ev.k === "r") {
                reread += readPrice(ev.m);
            } else if (ev.k === "t" && inRange(ev.at)) {
                const T = tool(tools, ev.n);
                const tokens = ev.ch / 4;
                const S = session(rt);

                T.calls++; T.errs += ev.er; T.tokens += tokens; T.carry += tokens * reread;
                S.tools[ev.n] = (S.tools[ev.n] ?? 0) + tokens * reread;
            }
        }
    }

    const hit = (t) => (t.i + t.r + t.w ? t.r / (t.i + t.r + t.w) : 0);
    const out = [];

    for (const S of sessions.values()) {
        if (S.req === 0) {
            continue;
        }

        const active = union(S.spans);
        const findings = [];
        const add = (id, saving, detail) => findings.push({ id, title: TIPS[id][0], saving, detail });
        const rpt = S.turns ? S.main / S.turns : 0;
        const [topTool, topCarry] = Object.entries(S.tools).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];

        if (S.brk.idle.lost >= 0.05) { add("idle", S.brk.idle.lost, `${S.brk.idle.n}× re-written after a pause`); }
        if (S.brk.model.lost >= 0.05) { add("model", S.brk.model.lost, `${S.brk.model.n} switch${S.brk.model.n > 1 ? "es" : ""}`); }
        if (S.brk.other.lost >= 0.1) { add("other", S.brk.other.lost, `${S.brk.other.n} breaks`); }
        if (S.excess >= 0.25 && S.excess >= 0.15 * S.cost) { add("bloat", S.excess * 0.5, `average context ${Math.round(S.ctxSum / S.req / 1000)}k, peak ${Math.round(S.peak / 1000)}k`); }
        if (topCarry >= 0.25 && topCarry >= 0.1 * S.cost) { add("tools", topCarry, `${topTool} results carry ≈$${topCarry.toFixed(2)}`); }
        if (S.light >= 0.5 && S.light >= 0.25 * S.cost) { add("light", S.light * Math.min(0.5, 1 - cheapest / outPrice(S.lightModel)), `$${S.light.toFixed(2)} on ${S.lightModel}`); }
        if (S.rs / (S.out || 1) >= 0.6 && S.rsCost >= 0.5 && S.rsCost >= 0.1 * S.cost) { add("think", S.rsCost * 0.5, `reasoning ≈$${S.rsCost.toFixed(2)}`); }
        if (S.turns >= 3 && rpt >= 25) { add("loop", 0, `${Math.round(rpt)} requests per prompt`); }

        out.push({
            id: S.id, cost: S.cost, sub: S.sub, req: S.req, turns: S.turns, rpt,
            first: S.first, last: S.last, wall: S.last - S.first, active, modelMs: S.modelMs, toolMs: S.toolMs, est: S.est,
            hit: hit(S.t), peak: S.peak, avg: S.ctxSum / S.req, t: S.t, c: S.c,
            models: Object.entries(S.models).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => m),
            brk: S.brk, findings: findings.sort((a, b) => b.saving - a.saving),
        });
    }

    out.sort((a, b) => b.cost - a.cost);

    const tips = {};

    for (const s of out) {
        for (const f of s.findings) {
            const t = (tips[f.id] ??= { id: f.id, title: TIPS[f.id][0], action: TIPS[f.id][1], saving: 0, sessions: [] });

            t.saving += f.saving;
            t.sessions.push({ id: s.id, saving: f.saving, detail: f.detail });
        }
    }

    const all = out.reduce((a, s) => ({ i: a.i + s.t.i, r: a.r + s.t.r, w: a.w + s.t.w, o: a.o + s.t.o }), { i: 0, r: 0, w: 0, o: 0 });
    const costBy = out.reduce((a, s) => ({ i: a.i + s.c.i, r: a.r + s.c.r, w: a.w + s.c.w, o: a.o + s.c.o }), { i: 0, r: 0, w: 0, o: 0 });

    return {
        at: Date.now(),
        since,
        totals: {
            cost: sum(out, (s) => s.cost), req: sum(out, (s) => s.req), sessions: out.length, t: all, c: costBy, hit: hit(all),
            active: sum(out, (s) => s.active), modelMs: sum(out, (s) => s.modelMs), toolMs: sum(out, (s) => s.toolMs),
        },
        days: Object.values(days).sort((a, b) => a.d.localeCompare(b.d)),
        models: Object.values(models).sort((a, b) => b.cost - a.cost).map((M) => ({ ...M, avgCtx: M.ctx / M.req, hit: M.tr / (M.ctx || 1) })),
        tools: Object.values(tools).sort((a, b) => b.carry + b.ms / 1e4 - (a.carry + a.ms / 1e4)).slice(0, 15),
        tips: Object.values(tips)
            .map((t) => ({ ...t, sessions: t.sessions.sort((a, b) => b.saving - a.saving).slice(0, 5) }))
            .sort((a, b) => b.saving - a.saving),
        sessions: out.slice(0, 300),
    };
}

// ——— on its own: update the cache and print the report ———

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`);
const dur = (ms) => (ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1)}h` : ms >= 60e3 ? `${Math.round(ms / 60e3)}m` : `${Math.round(ms / 1e3)}s`);

if (process.argv[1]?.endsWith("analyse.mjs")) {
    const args = process.argv.slice(2);
    const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
    const home = process.env.HOME ?? ".";
    const data = process.env.PI_POCKET_DIR ?? `${home}/.pi-pocket`;
    const cache = await refresh(arg("db", `${data}/pocket.sqlite`), arg("cache", `${data}/usage-analyser/cache.json`), args.includes("--full"));
    const days = args.includes("--all") ? 0 : Number(arg("days", 30));
    const report = analyse(cache, { since: days ? Date.now() - days * 86400e3 : 0 });

    if (args.includes("--json")) {
        console.log(JSON.stringify(report));
    } else {
        const T = report.totals;

        console.log(`${days ? `Last ${days} days` : "All time"}: $${T.cost.toFixed(2)}, ${T.req} requests, ${T.sessions} sessions, cache hit ${(T.hit * 100).toFixed(0)}%, active ${dur(T.active)}`);
        console.log(`Cost by type: input $${T.c.i.toFixed(2)}, cache write $${T.c.w.toFixed(2)}, cache read $${T.c.r.toFixed(2)}, output $${T.c.o.toFixed(2)}`);
        console.log("\nTop sessions (cost, active time, cache hit, peak context):");

        for (const s of report.sessions.slice(0, 10)) {
            console.log(`  #${s.id} $${s.cost.toFixed(2)} ${dur(s.active)} ${(s.hit * 100).toFixed(0)}% ${fmt(s.peak)}  ${s.findings.map((f) => f.id).join(",")}`);
        }

        console.log("\nWhat to change:");

        for (const t of report.tips) {
            console.log(`  ${t.title}: up to $${t.saving.toFixed(2)} — ${t.action}`);
        }
    }
}
