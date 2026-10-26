/**
 * Usage analyser (experimental): tokens, cost, cache use and time of every session, with findings that say how to
 * spend less. The findings are first guesses, and ideas for other ways to analyse usage are welcome. It reads the model requests in Pi Pocket's own store (counts, timings, tool names; never message text) through a
 * helper script that keeps an incremental cache, and shows the report on a page. Owner only. No network.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Host, Web } from "./_pocket.d.ts";

const RANGES = new Set(["7", "30", "90", "0"]);

export default function createUsageAnalyser(host: Host, web: Web) {
    const core = join(import.meta.dirname, "usage-analyser", "analyse.mjs");
    const db = join(host.dataDir, "pocket.sqlite");
    const cache = join(host.dataDir, "usage-analyser", "cache.json");
    // One run per range at a time; a second page asking meanwhile shares it.
    const running = new Map<string, Promise<any>>();

    function run(days: string) {
        let job = running.get(days);

        if (!job) {
            job = new Promise((resolve, reject) => {
                const range = days === "0" ? ["--all"] : ["--days", days];

                // A child process, so reading a large store never stops the server.
                execFile(
                    process.execPath,
                    ["--no-warnings", core, ...range, "--json", "--db", db, "--cache", cache],
                    { maxBuffer: 64 * 1024 * 1024 },
                    (error, stdout, stderr) =>
                        error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout)),
                );
            }).finally(() => running.delete(days));
            running.set(days, job);
        }

        return job;
    }

    web.route("GET", "report", async ({ query, sessions }) => {
        const days = query.get("days") ?? "30";

        if (!RANGES.has(days)) {
            throw web.error(400, "days must be 7, 30, 90 or 0");
        }

        const report = await run(days);
        const known = new Map(sessions().map((each) => [each.id, each]));
        const name = (id: number) => known.get(id)?.title || `#${id}`;

        for (const each of report.sessions) {
            each.title = name(each.id);
            each.archived = known.get(each.id)?.archived ?? false;
        }

        for (const tip of report.tips) {
            for (const each of tip.sessions) {
                each.title = name(each.id);
            }
        }

        return report;
    });

    web.client("usage-analyser");
}
