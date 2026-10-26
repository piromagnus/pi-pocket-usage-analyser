# Usage analyser for Pi Pocket (experimental)

A Pi Pocket drop-in extension: a Usage page with tokens, cost by token type, cache hit rate, where each session's
time went, and findings that say how to spend less (cache expiry after pauses, long context, big tool results,
pricey model on routine steps, heavy thinking). **Ask PiP** sends the findings to PiP for a deeper analysis.

**Experimental.** The findings are first guesses and the savings are upper bounds. Ideas for other ways to analyse
usage are welcome: open an issue or a pull request.

A child process parses records from Pi Pocket's store but never keeps or shows message text. It caches token counts,
timings, tool names and result sizes in `<data>/usage-analyser/`. Ask PiP sends selected findings and session titles
to PiP and its configured model provider. The analyser makes no network requests itself.

This extension uses experimental `sessions()` and internal `/pip.js` and `pocket.sqlite` record shapes. They can
change in any Pi Pocket release and break the extension.

Install from the Pi Pocket extension gallery, then turn it on in Menu → Extensions. Command line:

    node ~/.pi-pocket/extensions/usage-analyser/analyse.mjs --days 30 [--json]

Test: `node --test test/*.test.mjs`.

MIT, Pierre Marrec.
