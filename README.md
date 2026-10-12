# Fantasy Badger for Sleeper

A Chrome extension that rebuilds Sleeper's league pages on the web so managing
your team is easier. Set your lineup by picking two players instead of dragging;
see what needs doing this week, with the points at stake; follow every matchup
live, play by play; and research players with usage numbers built from Sleeper's
own box scores. Everything is worked out for your league's own scoring and
roster settings, and the Badger menu in the top right switches back to Sleeper's own
layout at any time.

## What it reads, and what it sends

The extension works on sleeper.com, inside your own Sleeper session, and talks
to Sleeper and nothing else.

League, roster, matchup, player, chat and transaction data are read through
Sleeper's own endpoints with your existing session, and the actions you take —
lineup changes, adds and drops, waiver claims, trade offers, chat messages — go
through those same endpoints. Headshots come from Sleeper's image server. Every
number on the pages (projections for your scoring, playoff odds, live win
probability, usage) is worked out in your browser. Your Sleeper session token
never leaves it except to Sleeper.

There is no other server: no Fantasy Badger service, no analytics, and no font
service — the two typefaces are in `fonts/`, with their licences. The extension
asks Chrome for `storage` and for access to sleeper.com, and no other
permission.

Privacy policy: https://fantasybadger.com/privacy/extension

## Load it yourself

The files here are exactly the package the Chrome Web Store serves. To run them
without the store: open `chrome://extensions`, turn on Developer mode, choose
**Load unpacked**, and pick this folder.

## Licence

The code is MIT-licensed; see [LICENSE](LICENSE). The fonts in `fonts/` are
Nunito and IBM Plex Mono, under the SIL Open Font License (the licence files are
beside them). The Fantasy Badger name and the badger artwork are not covered by
either licence: a fork must use its own name and icons.

Found a bug or want something added? Open an issue.
