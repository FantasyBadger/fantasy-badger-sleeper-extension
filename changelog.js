// What's new, as the league pages show it: newest release first. Written for
// the people using the extension, in their words: what they can now do, never
// how it is built.
//
// An entry is keyed by the day its release was cut, in UTC, as year.month.day:
// the first three numbers of that release's version. A release with nothing new to
// say adds none and rides under the latest one.
globalThis.BADGER_NOTES = [
    {
        v: '2026.10.25', when: 'October 25, 2026', title: 'A Breakdown tab for your matchup, and NFL games by drive',
        items: [
            'Your matchup has two tabs. <b>Live</b> is the page you know. <b>Breakdown</b> adds over and under performers in your game, who has moved the win odds most, where each side’s points came from, big plays and the red zone, how your score stacks up across the league, bench points and the best possible lineup, and your record against this opponent in every season.',
            'Win probability has a third view, <b>Projected</b>: each side’s projected final through the week.',
            'Head to head shows each player’s face, ringed by his game clock: a full ring before kickoff that empties as his game runs. A <b>Positions</b> view adds up each position, with the flex as its own; press one to see its players.',
            'The league’s other matchups sit in a rail beside yours, with <b>All matchups</b> at the top. On a narrower window the rail shows each team’s avatar and score, and the play log leaves out its Score now column to make room.',
            '<b>NFL games</b> lists every drive beside the plays of the one you open, with its plays, yards, time and starting spot, and what each play gained.',
            'The field is drawn to scale: ten-yard bands, yard numbers, midfield and both red zones. Between a score and the kickoff, it says who kicks off.',
            'Player names in the play by play are in bold: teal for yours, blue for your opponent’s.',
            'Touchbacks and two-point tries no longer count as drives of their own.',
        ],
    },
    {
        v: '2026.10.24', when: 'October 24, 2026', title: 'NFL games, rebuilt, and player nicknames',
        items: [
            '<b>NFL games</b> puts the play by play right under the score: one drive at a time, newest play first, with earlier drives a press away and a list of every drive.',
            'Each team’s players are grouped by position. <b>Points</b> draws each player’s projection on his points bar, so you can see who is running hot or cold; <b>Box score</b> lines every position up on one grid, and a header sorts it.',
            'The fantasy points on each play carry the player’s face, and Scoring sits beside Team stats.',
            'Player nicknames: the name his team gave him shows under his name on his card and on the Team roster. Name your own players from their card. Sleeper posts a new nickname in league chat.',
            'A back-up on a waiver claim is one rule: <b>if no spot is open, drop this player and bid this much</b>. Each rule is exactly one claim in Sleeper.',
            'A claim that can fail says every reason, such as no open spot and no money left, and its fix covers both.',
            'The Team page has one lineup button. Its window lists every check (empty slots, byes, players out or questionable, the flex, your best lineup) as passing or needing a fix. Keep a questionable player in when you mean to, and the check stays quiet.',
            'Byes now show in <b>Weeks ahead</b>.',
            'During games, Over / under performers compares each player to where his projection says he should be by now, and a D/ST waits for the final whistle.',
            'The live game line on your roster wraps instead of being cut off, and the Players quick filters and roster arrows keep working while games are on.',
        ],
    },
    {
        v: '2026.10.14', when: 'October 14, 2026', title: 'Waiver claims that say what will happen',
        items: [
            '<b>Transactions</b> is two tabs under one search box: <b>Waivers & Adds</b> (your claims, ideas for who to add, and history) and <b>Trades</b> (offers and history).',
            'One row per player you claim, with your bid and your drop right in the row. Change who a claim drops, or drop nobody, without filing it again.',
            'Add a condition when you want one: a back-up drop if no spot is open, a back-up bid if you are out of FAAB by then, or a second choice if you miss your first. The × on a condition takes it out.',
            '<b>What will happen</b> plays out every way the waiver run can go, money, open spots and drops already gone, and says it in sentences. A claim that can fail is flagged on its row, with one press to fix it.',
            'Change the order of claims at the same bid with the arrows beside them.',
            'History says what happened to each player in the last run, for you or the whole league.',
            'Choosing a drop lists your whole roster, fewest rest-of-season points first, with each player’s bye, this week’s projection and rest of season.',
            'Commissioners: a trade both teams accepted waits under <b>Trades › Review</b>, and on Home, until the review ends. Approve it now or veto it from there.',
            'Bench a starter with nobody coming in.',
            'Home’s top bar lists only what needs doing; your claims stay in Transactions.',
            'D/ST points in the matchup’s play-by-play now match Sleeper’s on forced fumbles, blocked kicks and return touchdowns.',
        ],
    },
    {
        v: '2026.10.12', when: 'October 12, 2026', title: 'Numbers that say where a player stands',
        items: [
            'A new top bar: the pages on the left, <b>Transactions</b> and <b>Chat</b> as buttons on the right, and a <b>Badger</b> menu in the corner for the layout switch, What’s new and feedback. The week picker moved onto the pages that use it.',
            '<b>Usage</b> on Team and Players is one table with the same columns in the same places for every position, led by <b>OPP PTS</b>: what a player’s share of his offence is usually worth in your league’s scoring. Point at a column header for what it means and how this season’s players at his position compare.',
            'Every usage number is drawn by where it ranks at his position: bold for the top group, plain for a starter in your league, grey and dim below that. Point at a number for his exact rank, and stay there to see his season week by week against the top group, a typical starter and the middle of his position.',
            'A rate such as yards per target is ranked only with enough work behind it, so one long catch no longer looks like the best in the league.',
            'Two quick filters on Players: <b>Underperforming</b>, a starter’s opportunity without the points yet, and <b>Overperforming</b>, late picks scoring well above their workload.',
            'Standings can count the week in progress as it is projected to finish. <b>Week N as projected</b> gives each game to the team projected to win it, not to the one ahead on the scoreboard with fewer players left.',
            'An injury designation keeps up during the games: a player ruled out mid-game shows as Out without reloading the page.',
            'The Scoreboard link says <b>LIVE</b> while games are on, overtime plays read OT, and the play log runs in the order the plays happened.',
            'Transactions and Chat open under the top bar, so the bar and its menus stay in reach.',
            'On your roster, the Insight column shows with projections, where it helps set a lineup. Actual and Usage give its room to the numbers.',
        ],
    },
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
