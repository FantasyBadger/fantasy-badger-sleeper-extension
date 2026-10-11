// What's new, as the league pages show it: newest release first. Written for
// the people using the extension, in their words: what they can now do, never
// how it is built.
//
// An entry is keyed by the day its release was cut, in UTC, as year.month.day:
// the first three numbers of that release's version. A release with nothing new to
// say adds none and rides under the latest one.
globalThis.BADGER_NOTES = [
    {
        v: '2026.10.8', when: 'October 8, 2026', title: 'Claims, adds and trades in one place',
        items: [
            'A <b>Transactions</b> tab (⇄) next to Players: your claims and trade offers, what’s waiting on you, and the league’s waiver results and trades.',
            'Claim or add a player from anywhere. One card shows your bid, who else wants him, what the move does to your week and your season, and your whole roster to drop from.',
            '<b>Just dropped</b>: players other teams let go who are on waivers now, one click to claim.',
            'Once a player’s game has kicked off he shows as a claim, not an add, until your league’s waivers run — with the day and time on the button.',
            'Cancel a trade offer you sent, right from its card.',
            'Switch between this layout and Sleeper’s own with the toggle in the top right.',
            'Copy any card as a picture with the button in its corner, your league and the time underneath, ready to paste into the group chat.',
            'Point at the win-probability line to see each play: the score right after it, and how far it moved the chance to win. Biggest plays and Latest plays show the score right after each play too.',
            'The player card leads with four numbers by your league’s scoring, each with his rank at his position: the season, this week, next week and the rest of the season. Under the newest story, his whole season runs week by week, played and still to come, and <b>News & moves</b> keeps his last ten stories. On <b>Usage</b>, every row draws his whole season week by week beside the numbers, with his last four games shaded.',
            'League standings can show the week in progress as it stands: turn on <b>Week N as it stands</b> and every column counts this week as if it ended now, with who moved and who crosses the playoff line.',
        ],
    },
    {
        v: '2026.9.15', when: 'September 15, 2026', title: 'Lineups that count, and a better Scoreboard',
        items: [
            'Lineup changes save to the week Sleeper scores, so a swap made here always counts.',
            '<b>Late flex</b> puts your latest kickoffs in the flex slots, and an unused bench spot shows as a row you can fill.',
            'The Scoreboard splits into your league’s matchups and the NFL games, with your own game one click away.',
            'The play log shows the score after every play and both teams’ chances to win, in the order the plays were run.',
            'League chat updates live, shows GIFs and older messages, and shows roster moves and waiver results as ADD and DROP cards.',
            'The week turns the morning after its last game, not at the final whistle.',
        ],
    },
    {
        v: '2026.9.14', when: 'September 14, 2026', title: 'Live Sundays',
        items: [
            'Plays, stat lines and game clocks update as they happen.',
            'The NFL games on one screen, with what each play meant for your fantasy players.',
            'FINAL only once every game of the week is over.',
        ],
    },
    {
        v: '2026.9.12', when: 'September 12, 2026', title: 'The whole league on one screen',
        items: [
            'Every matchup of the week at once, with each team’s chance to win and the plays that moved it.',
            'League chat and your direct messages together in one drawer.',
            'The news feed names its source, links the story, and lets you mute a source you don’t want.',
            'A League page with the standings, the playoff picture and the draft.',
            'Adding a player shows what it does to your week and your season, with the byes ahead.',
        ],
    },
];
