# Schedula

A time-blocked schedule + habit tracker that holds you to your plan. It's an installable app that works fully offline, with no account and no cloud.

## Install it (one time)

1. Double-click **`start.bat`**. It starts a small local server and opens http://localhost:5178. (Or run `python -m http.server 5178` in this folder.)
2. In Chrome or Edge, click **Install app** in the sidebar, or the install icon in the address bar.
3. That's it. Schedula now has its own window and a Start-menu/desktop icon, and it works **offline**. You don't need `start.bat` running any more.

Right-clicking the app icon gives shortcuts to **Today**, **Quick capture**, **Habits** and **Plan**.

> Your data is stored for the address `http://localhost:5178`. Always use that exact address (same port), or your data won't be there. To move data between browsers or devices, use **Settings → Export / Import backup**.

**On a phone:** host the folder on any HTTPS static host (for example GitHub Pages or Netlify), open it on the phone, then use *Add to Home Screen* (iPhone: Share → Add to Home Screen).

## Logo

The mark is a **stopwatch holding a checkmark**: a ring with a gap and a crown dot at 12 o'clock, around a bold white tick. It stands for time that's been handled. The master file is `icons/logo.svg` (used for the favicon and the sidebar). The PNG app icons are generated from the same shape:

```bash
node tools/make-icons.js icons
```

## Offline & updates

- `sw.js` (a service worker) stores the whole app on first load: pages, styles, all quotes and the icons. Fonts are stored after the first online visit; until then, system fonts are used.
- An **Offline** badge appears when you lose your connection. Everything keeps working, and your data is saved on the device.
- **Shipping a change:** edit the files, then increase `VERSION` in `sw.js` (for example `'v7'` → `'v8'`). Open copies of the app show **"A new version is ready → Update"**. Without the version bump, installed apps keep serving the old stored files.
- Settings → **App** shows the install status, whether offline mode is ready, and whether storage is protected from automatic clearing.

## The rules it enforces

| Rule | What it means |
| --- | --- |
| **Check-in windows** | Each block opens for check-in 5 min before it starts and closes 10 min after (you can change both in Settings). If you don't check in, the block is marked **missed**. |
| **Commitment lock** | Today's schedule is frozen once the day starts. Plan changes you commit take effect **tomorrow**, and so do changes to the window rules. |
| **No retroactive habits** | You can only tick habits for today. Past days can't be changed. |
| **Accountability check** | Every missed block has to be answered with a written reason before you can use the app again. The reasons are kept in Stats → Accountability log. |
| **60-second undo** | A check-in can be undone for 60 seconds, in case you tapped by mistake. |
| **Days you don't open it still count** | If you skip opening the app for a few days, the blocks from those days are logged as missed. |

## Productivity tools

| Tool | How it works |
| --- | --- |
| **Top 3 priorities** | Name up to three outcomes that make today a win. They count toward your daily score. You can remove one only in the first 2 minutes after adding it. Any you don't finish move to your inbox the next day. |
| **Inbox / quick capture** | Press `N` anywhere to write down a task or idea without breaking focus. From the inbox you can tick an item done, promote it (★) to today's priorities, or delete it. |
| **Block intention** | After you check in, write the one concrete thing you'll finish in that block. |
| **Block review** | When a block ends, rate it as Nailed it, Partly or Slipped. The ratings make up your focus-quality score. |
| **Pomodoro timer** | Timed focus sessions (25 min by default) followed by a break (5 min). Sessions are counted per day, and the countdown shows in the browser tab. You can change both lengths in Settings. |
| **Shutdown ritual** | Every evening (from 17:00, or once your blocks are finished): rate the day from 1 to 10, write your wins and one lesson, and set tomorrow's top 3. |

## Pages

- **Today**: the current or next block with a live countdown, today's timeline, today's habits, and today's score. Press `F` for Focus mode.
- **Habits**: a monthly check grid by week, with streaks, monthly completion and a daily completion bar for each day.
- **Plan**: a weekly time-block editor (checks for overlaps, lets you copy a day to other days) and a **wizard** that builds a whole week from your wake time, sleep time, work hours, gym, project work and reading.
- **Stats**: day streak, 7- and 30-day averages, an 18-week consistency heatmap, a 14-day score chart, completion rate for each habit, and the accountability log.
- **Settings**: window rules, sound, desktop notifications, JSON export/import, and reset.

Keyboard shortcuts: `1`–`5` switch pages, `F` opens Focus mode, `N` opens quick capture, `Q` shows another quote, `Esc` closes dialogs.

### Quote of the day

Under the greeting on Today there's a **quote of the day** drawn from `quotes.js`: 195 quotes from 92 authors, including philosophers, writers, scientists, leaders and athletes.

- **One new quote each day.** It stays the same all day, even if you reload.
- **No repeats until every quote has been shown.** After that, the list reshuffles into a new round, so it never runs out. Yesterday's quote is never shown again straight away.
- **↻ (or `Q`)** shows a bonus quote without using up the daily list. "back to today's" returns you to the quote of the day.
- **Adding your own:** add lines to `quotes.js` in the form `["quote", "Author", "Source"]`. New quotes are added to the current round automatically, and exact duplicates are ignored.
- Hover over the quote to see how far through the current round you are.

Stats also shows priority completion, focus quality, pomodoro count, time spent per category (done vs planned) and a journal of your evening reviews.

## Data

All data is saved in this browser's `localStorage` under `schedula.v1` and never leaves your device. Use **Settings → Export backup** regularly. Clearing your browser data deletes everything that hasn't been exported.
