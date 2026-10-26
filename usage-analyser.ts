/**
 * Usage analyser (experimental): token, cost, cache and time findings; ideas for other analyses are welcome. An
 * owner-only page runs a child process that reads Pi Pocket records, never keeps or shows message text, and stores
 * a cache in <data>/usage-analyser/. Ask PiP sends findings to PiP. sessions() is experimental; /pip.js and the
 * pocket.sqlite record shapes are internal and can change in any release. The analyser makes no network requests;
 * PiP may send findings to its model provider.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Host, Web } from "./_pocket.d.ts";

const RANGES = new Set(["7", "30", "90", "0"]);

export default function createUsageAnalyser(host: Host, web: Web) {
    const core = join(import.meta.dirname, "usage-analyser", "analyse.mjs");
    const db = join(host.dataDir, "pocket.sqlite");
    const cache = join(host.dataDir, "usage-analyser", "cache.json");
    function run(days: string, signal: AbortSignal) {
        return new Promise<any>((resolve, reject) => {
            const range = days === "0" ? ["--all"] : ["--days", days];

            execFile(
                process.execPath,
                ["--no-warnings", core, ...range, "--json", "--db", db, "--cache", cache],
                { maxBuffer: 64 * 1024 * 1024, timeout: 120_000, signal, env: { HOME: process.env.HOME } },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                        return;
                    }
                    try {
                        resolve(JSON.parse(stdout));
                    } catch (failure) {
                        reject(failure);
                    }
                },
            );
        });
    }

    web.route("GET", "report", async ({ query, sessions, signal }) => {
        const days = query.get("days") ?? "30";

        if (!RANGES.has(days)) {
            throw web.error(400, "days must be 7, 30, 90 or 0");
        }

        const report = await run(days, signal);
        const known = new Map(sessions().map((each) => [each.id, each]));
        const name = (id: number) => known.get(id)?.title || `#${id}`;

        for (const each of report.sessions) {
            each.title = name(each.id);
            each.archived = known.get(each.id)?.archived ?? false;
        }

        for (const tip of report.tips) {
            for (const each of tip.sessions) {
                each.title = name(each.id);
                each.quotedTitle = host.text.quoted(each.title, 80);
                each.quotedDetail = host.text.quoted(each.detail, 160);
            }
        }

        // Quote the executable path for a shell, including data folders that contain spaces or quotes.
        report.command = `node '${core.replaceAll("'", "'\\''")}' ${days === "0" ? "--all" : `--days ${days}`} --json --db '${db.replaceAll("'", "'\\''")}' --cache '${cache.replaceAll("'", "'\\''")}'`;
        return report;
    });

    web.client("usage-analyser");
}
