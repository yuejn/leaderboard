# leaderboard

A single static page that reads a published Google Sheet and renders it as a
sortable, filterable, paginated table. No build step, no dependencies, no
backend — the browser fetches the CSV on every page load.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and element ids |
| `style.css` | All styling |
| `leaderboard.js` | Pure data layer — CSV parsing, ranking, filtering, sorting. No DOM |
| `app.js` | DOM layer — fetching, rendering, controls, loading/error states |
| `config.json` | **Every tunable value.** Edit this, not the code |
| `test.mjs` | Tests for the data layer — `node --test` |
| `package.json` | Marks the directory as ES modules for Node. No dependencies |
| `robots.txt` | Asks crawlers to stay away — see *Being findable* |
| `.nojekyll` | Stops GitHub Pages running the files through Jekyll |

## Changing things

Everything adjustable lives in `config.json`. Edit it, commit, push — Pages
redeploys and the change is live. Nothing below is duplicated in the JavaScript.

| Key | What it does |
| --- | --- |
| `csvUrl` | The published-sheet CSV URL (see below) |
| `pageSize` | Rows per page on the wide layout. **`0` = no pagination** |
| `mobilePageSize` | Rows per page on the narrow layout. **`0` = no pagination** |
| `refreshMinutes` | How often an open page re-reads the sheet. **`0` = only on load** |
| `playersNote` | The line under the title, after the row count |
| `updatedLabel` | The word before the last-read time on that same line |
| `scoreLabel` | Column heading for the sheet's `Score` column |
| `provisionalLegend` | First legend line under the filters |
| `hostedThreshold` | `Hosted >= this` marks someone a host |
| `hostLabel` | Appended to a host's status, e.g. `ranked · host` |
| `hostSeparator` | What sits between the two, e.g. `" · "` |
| `hostPlayingNote` | Tooltip on a host's rank and score cells |
| `hostedCountLabel` | The word before the count in the hosts view, e.g. `hosted 3` |
| `quizmasterIds` | Sheet `ID`s of the people who run the quiz, e.g. `[26]` |
| `quizmasterLabel` | What their status cell says instead of `Ranked`/`Provisional` |
| `attendance` | Maps each `Attended` value to a `mark` and a `title` |
| `defaultShow` | Which filter is active on load — `ranked`, `all`, `provisional`, `hosts` |
| `defaultSort` | `{ "key": …, "dir": "asc" \| "desc" }` |

A missing or malformed key shows an error naming it rather than failing
silently.

### Staying current

The sheet is fetched fresh on every page load, which is how the numbers are
almost always current. On top of that, an *already open* page re-reads the sheet
every `refreshMinutes` and again when you return to a tab that has been sitting
in the background longer than that. Your sort, filter, bucket, page and pins all
survive a refresh.

`refreshMinutes` is **1440** — once a day. The quiz updates every couple of
months, so polling any harder would be asking Google the same question hundreds
of times for an answer that changes six times a year; a day is enough to stop a
tab left open over the weekend from showing numbers from before the last quiz.
Set it to `0` to switch background refreshing off entirely.

A refresh that fails is swallowed: the standings already on screen stay up and
the next attempt is minutes away. That is not a contradiction of "if it's down,
it's down" — that rule is about the *first* load, which has nothing to fall back
on and still shows an error and a retry link.

### Linking to a view

The sort, filter, bucket and page number live in the query string
(`?show=all&q=finland&sort=score:asc&page=2`), so any view can be linked to and
the back button walks the views you visited. Anything left at its default is
left out, so the landing view keeps a bare URL. Typing in the filter box
replaces the current history entry rather than adding one, so back doesn't
retrace every keystroke.

Pins are deliberately **not** in the URL — they are yours, not part of what a
shared link should carry.

### Pagination

Paging is decided by how wide the table is, not by the device. Below 520px each
row becomes a five-line stacked block, so the full list turns into a very long
scroll and `mobilePageSize` kicks in; above it the whole table fits on screen and
`pageSize` is `0`, so every row is shown and the pager is hidden. Resizing across
the breakpoint re-renders and returns to page 1.

If the sheet grows past a few hundred entries, set `pageSize` to a number and the
wide layout starts paging too.

The 520px breakpoint is written down **once**, in `style.css`. A container query
can't read a custom property in its condition and can't match the container
itself, so the query sets `--narrow: 1` on a zero-height `#width-probe` element
and the script reads that back to find out which layout is live. If you move the
breakpoint, move it there and nothing else needs to change.

> The `520` breakpoint lives in two places that must agree: the `@container`
> rule in `style.css` and `NARROW_WIDTH` in `app.js`.

The page title, the description paragraph under it, and the column headings are
plain text in `index.html`.

## The sheet

The page expects these column headers, matched **by name** — reordering columns
in the sheet is safe, renaming them is not.

| Column | Notes |
| --- | --- |
| `ID` | Stable integer per person. Never displayed; used as the sort tiebreaker |
| `Initials` | Displayed as-is. A blank value marks the row as junk and drops it |
| `Country` | Free text, shown exactly as written |
| `Score` | e.g. `56%`. Blank or non-numeric sorts last and shows `—` |
| `Status` | `Ranked` or `Provisional` |
| `Hosted` | Integer count of quizzes hosted. Never displayed as a column |
| `Attended` | Blank, `30%+`, or `60%+`. Never displayed as a column |

`Initials`, `Country`, `Score` and `Status` are required. `ID`, `Hosted` and
`Attended` are optional and default to sensible values if absent.

### How ranking works

Rank is computed over the whole sheet before any filtering, so the numbers never
shift when you sort or filter.

- Only `Ranked` rows with a numeric score are ranked.
- **Competition ranking**: ties share a rank and the next rank skips — 1, 2, 2, 4.
- `Provisional` rows show `—`.
- Hosts are ranked normally; hosting doesn't remove anyone from the standings.

### Hosts

Anyone with `Hosted >= hostedThreshold` keeps their real rank and score. The
row is greyed and the rank and win-rate cells carry a tooltip noting those
figures are their playing record.

Hosting is an *annotation on* their status, not a replacement for it — the
status cell reads `ranked · host` or `provisional · host`. That matters: a host
can be ranked or provisional, and collapsing both to `host` made a ranked host
and an unranked one look identical. They still appear under `ranked` /
`provisional` according to their real status, and sort with their own group.

**`show: hosts` is a different question.** It lists everyone who has *ever*
hosted — `Hosted >= 1`, plus the quizmasters — not just those over
`hostedThreshold`. The threshold decides who gets marked a host in the
standings, which is a judgement about how much of their record is missing from
their score; the hosts view is a roster, and one that leaves out someone who
hosted once is simply wrong.

So the two can disagree, deliberately: someone who hosted once appears in the
hosts list but is *not* greyed, tooltipped or labelled `· host` in the
standings. To keep the roster readable, the status cell in that view shows the
count instead of the `· host` suffix — `ranked · hosted 1`, `quiz master ·
hosted 12` — since in a list of nothing but hosts the word is noise and the
number isn't. That wording is `hostedCountLabel`.

### Quizmasters

Anyone whose sheet `ID` appears in `quizmasterIds` shows `quiz master` in the
status cell, with no `Ranked`/`Provisional` at all. They're running the quiz
rather than competing in it, and `Status` describes *games played* — so it would
label the person with the deepest involvement a "provisional" newcomer, which is
exactly backwards.

They are still treated as a host in every other respect (greyed row, tooltip,
included in `show: hosts`), and they still rank normally if their sheet status
is `Ranked`.

Identifying them by `ID` rather than by a hosted-count threshold is deliberate:
with only a couple of hosts, any threshold is guesswork, and someone hosting one
more quiz shouldn't silently promote them. Add or remove `ID`s as the role
changes.

### Attendance

`30%+` and `60%+` render as a small `+` / `++` after the initials, explained in
the legend. Deliberately not a column — too few rows have a value for one to pay
its way.

## Reading the page

### Pinning

Click anyone's initials to pin them. Pinned rows go bold and sort to the top
through every sort and direction, so pinning two people puts them side by side
for comparison. Pins live in the reader's own browser (`localStorage`) and
survive reloads — they are never shared or stored anywhere else.

Pins outrank the `show:` buttons but not the filter box:

- **`ranked` / `all` / `provisional` / `hosts`** — a pinned row shows through a
  bucket that excludes it. These are view modes you set once and leave, and
  hiding your pinned people behind one defeats the point of pinning.
- **`filter:`** — a pinned row must still match what you type. The filter box is
  an active search; a pinned row you didn't ask for is just noise.

A row shown only because it's pinned is separated from the rest by a hairline,
and counted on its own (`showing 28 of 62 · 1 pinned`) so the headline number
still means "rows matching this view".

Pins are keyed on the sheet's `ID`, so reusing an ID for a different person
inherits their pins.

### The filter box

`filter:` matches on initials and country as you type. The `×` beside it clears
the field and puts the cursor back in it — on a phone the alternative is
selecting the text and hunting for backspace. The browser's own clear button
inside search fields is suppressed, because it isn't in every browser and can't
be made a 44px touch target; this one is, on narrow layouts.

### Country links

Every country is a filter link. Dual entries split into separate links, so
`U.K. / Finland` gives a `U.K.` link *and* a `Finland` link — which is the only
way some countries are reachable at all.

### Stats

The collapsed `stats` panel describes **what is currently on screen**, not the
whole sheet, so filtering to one country shows that country's shape. It holds a
summary line, a win-rate histogram in bands of ten, and players per country
(each also a filter link). Histogram bars are scaled so the tallest band fits a
fixed width — one block per player ran off the side of a narrow screen — and the
count is printed after each bar, so nothing is lost to the scaling.

Counts only — no per-country averages. Most countries here have one or two
players, so an average would be noise dressed up as a ranking. Note that someone
recorded under two countries counts once for each, so the country counts total
more than the number of players; the panel says so when that applies.

## Re-publishing the sheet

`csvUrl` is a *publish-to-web* link, not a share link. It is tied to whichever
Google account published it, and it breaks if that publish is revoked or the tab
is deleted. To reissue one:

1. Open the sheet → **File → Share → Publish to web**
2. Pick the tab, choose **Comma-separated values (.csv)**, publish
3. Copy the URL and paste it into `config.json` as `csvUrl`

> **Owner:** _TODO — record which Google account owns this sheet, so the next
> person knows where to go when the link stops working._

The sheet must stay published for the page to work. If it isn't, the page says
so rather than showing a blank table. There is no cached fallback: if the sheet
is unreachable, the page shows an error and a retry link. That is deliberate.

## Being findable (or not)

The page asks not to be indexed — `<meta name="robots" content="noindex,
nofollow, noarchive">` plus a `robots.txt` that disallows everything. Search
engines that respect those (Google, Bing, DuckDuckGo do) will keep it out of
results, so it won't turn up when someone searches a name on it.

**This is not privacy, and it should not be relied on as any.** Anyone with the
URL can open the page — there is no login and no way to add one on GitHub Pages.
Specifically:

- A **GitHub Pages site is public even when the repository is private.** Access
  control for Pages is a GitHub Enterprise feature.
- The repository, if public, exposes `config.json` — and with it the sheet's
  CSV URL, which serves the whole sheet to anyone who asks.
- The published sheet is public to anyone with *its* link too, independently of
  this site.
- Crawlers that ignore `robots.txt`, and anything that scrapes links out of
  chat apps or email, are unaffected.

If the standings genuinely shouldn't be readable by strangers, the site being
hard to find is the wrong tool: either keep it off Pages and share the file some
other way, or put it behind something that can actually authenticate (Cloudflare
Access, Netlify password protection, a private host). Given the content is
initials and win rates, "unindexed and unlisted" may well be enough — that is a
judgement call, and it should be a deliberate one.

## Deploying

**Settings → Pages → Deploy from branch → `main` / root.** Pushing to `main` is
the deploy.

## Running it locally

The page fetches `config.json` and uses ES modules, so opening `index.html`
straight off disk won't work — it needs to be served over HTTP:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Browser support

Uses `light-dark()`, container queries, CSS nesting, ES modules and
`Array.prototype.toSorted` — all available in current Chrome, Safari, Firefox
and Edge. Colours follow the reader's light/dark preference automatically.
