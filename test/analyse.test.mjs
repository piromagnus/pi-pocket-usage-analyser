import assert from "node:assert/strict";
import { test } from "node:test";
import { analyse, emptyCache } from "../usage-analyser/analyse.mjs";

const req = (e, s, over = {}) => ({
    k: "r", e, c: 1, s, d: 2000, ti: 10, tr: 0, tw: 0, to: 100, w1: 0, rs: 0, ci: 0, cr: 0, cw: 0, co: 0.01,
    m: "m", p: "p", x: "toolUse", th: "", id: `r${e}`, ...over,
});

test("a request after a long pause re-writes the context at the write price", () => {
    const cache = emptyCache();
    const t0 = 1_000_000;

    cache.events.push(
        req(1, t0, { tr: 50_000, cr: 0.025 }),
        // 20 minutes later: all 50k tokens are written again instead of read.
        req(2, t0 + 20 * 60e3, { tw: 50_000, cw: 0.2 }),
        req(3, t0 + 20 * 60e3 + 5000, { tr: 50_000, cr: 0.025 }),
        { k: "t", e: 4, c: 1, at: t0 + 20 * 60e3 + 4500, n: "bash", ch: 40_000, er: 0 },
    );

    const report = analyse(cache);
    const [s] = report.sessions;

    assert.equal(s.req, 3);
    assert.equal(s.brk.idle.n, 1);
    assert.ok(s.brk.idle.lost > 0.15 && s.brk.idle.lost < 0.2, String(s.brk.idle.lost));
    assert.ok(report.tips.some((t) => t.id === "idle"));
    assert.equal(report.tools[0].n, "bash");
});

test("subagent requests count in their session; forked copies count once", () => {
    const cache = emptyCache();

    cache.owners[2] = 1;
    cache.events.push(req(1, 1000), req(2, 5000, { c: 2 }), req(3, 5000, { c: 3, id: "r2" }));

    const report = analyse(cache);

    assert.equal(report.sessions.length, 1);
    assert.equal(report.sessions[0].req, 2);
});
