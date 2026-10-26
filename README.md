# Usage analyser for Pi Pocket (experimental)

A Pi Pocket drop-in extension: a Usage page with tokens, cost by token type, cache hit rate, where each session's
time went, and findings that say how to spend less (cache expiry after pauses, long context, big tool results,
pricey model on routine steps, heavy thinking). **Ask PiP** sends the findings to PiP for a deeper analysis.

**Experimental.** The findings are first guesses and the savings are upper bounds. Ideas for other ways to analyse
usage are welcome: open an issue or a pull request.

It reads only token counts, timings, tool names and result sizes from Pi Pocket's own store, never message text, in a
child process with an incremental cache in `<data>/usage-analyser/`. No network.

Install from the Pi Pocket extension gallery, then turn it on in Menu → Extensions. Command line:

    node ~/.pi-pocket/extensions/usage-analyser/analyse.mjs --days 30 [--json]

Test: `node --test test/`.

MIT, Pierre Marrec.
