import {
	AppError,
	COLUMNS,
	SHOW_VALUES,
	SORTS,
	barLengths,
	countryCounts,
	parseRows,
	matches,
	scoreBands,
	selectRows,
	summarise,
	validateConfig,
} from "./leaderboard.js";

const CONFIG_URL = "./config.json";
const FILTER_DEBOUNCE_MS = 150;
const FETCH_TIMEOUT_MS = 15_000;
const PINS_KEY = "leaderboard:pins";
const MAX_BAR = 24;

const board = document.querySelector("main");

// The narrow breakpoint lives in style.css alone; the probe reports whether the
// container query is currently matching. An unloaded stylesheet reads as wide,
// which is the layout the markup already is.
const probe = document.getElementById("width-probe");
const isNarrow = () => getComputedStyle(probe).getPropertyValue("--narrow").trim() === "1";

const el = Object.fromEntries(
	[
		"meta", "message", "controls", "filter", "clear-filter", "show", "legend", "table", "thead",
		"tbody", "hint", "pager", "prev", "next", "pager-status", "count", "sort-select",
		"pins", "stats", "stats-summary", "histogram", "stats-countries", "stats-note",
	].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), document.getElementById(id)]),
);

let cfg = null;
let rows = [];
let built = false;
const state = {
	sortKey: "score", sortDir: "desc", show: "all", query: "", page: 1,
	pinned: loadPins(),
};

// Pins are a per-visitor convenience, so they live in the browser. Every access
// is guarded: storage throws outright in some privacy modes.
function loadPins() {
	try {
		return new Set(JSON.parse(localStorage.getItem(PINS_KEY) ?? "[]"));
	} catch {
		return new Set();
	}
}

function savePins() {
	try {
		localStorage.setItem(PINS_KEY, JSON.stringify([...state.pinned]));
	} catch {
		/* pins just won't survive a reload */
	}
}

// ─── boot ────────────────────────────────────────────────────────────────────

async function boot() {
	showMessage("loading…");
	try {
		cfg = validateConfig(await loadJson(CONFIG_URL, "config.json"));
		Object.assign(state, {
			show: cfg.defaultShow,
			sortKey: cfg.defaultSort.key,
			sortDir: cfg.defaultSort.dir,
			query: "",
			page: 1,
		});

		rows = parseRows(await loadCsv(cfg.csvUrl), cfg);
		if (rows.length === 0) {
			showMessage("no entries yet.");
			return;
		}

		if (!built) {
			buildControls();
			built = true;
		}
		el.filter.value = "";
		el.meta.textContent = `${rows.length} total players all-time`;
		el.message.hidden = true;
		for (const node of [el.controls, el.table, el.pager]) node.hidden = false;
		render();
	} catch (error) {
		showError(error);
	}
}

// ─── loading ─────────────────────────────────────────────────────────────────

async function get(rawUrl, what) {
	const url = new URL(rawUrl, location.href);
	url.searchParams.set("_cb", Date.now()); // always read through to current data

	let response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		throw new AppError(
			error?.name === "TimeoutError"
				? `${what} took too long to respond`
				: `couldn't reach ${what}`,
			{ cause: error },
		);
	}
	if (!response.ok) throw new AppError(`couldn't load ${what} (HTTP ${response.status})`);
	return response;
}

async function loadJson(url, what) {
	const text = await (await get(url, what)).text();
	try {
		return JSON.parse(text);
	} catch {
		throw new AppError(`${what} is not valid JSON`);
	}
}

async function loadCsv(url) {
	const response = await get(url, "the sheet");
	const type = response.headers.get("content-type")?.toLowerCase() ?? "";
	const text = await response.text();

	// An unpublished or renamed sheet serves an HTML sign-in page, not CSV.
	if (text.trimStart().startsWith("<")) {
		throw new AppError("the sheet isn't published as CSV — got an HTML page back");
	}
	if (type && !["text/csv", "text/plain"].some((ok) => type.includes(ok))) {
		throw new AppError(`the sheet returned an unexpected content type (${type})`);
	}
	return text;
}

// ─── render ──────────────────────────────────────────────────────────────────

function render() {
	// Wide: the whole table fits, so paginating it only hides rows. Narrow: each
	// row is a five-line block, so 62 of them is a very long scroll.
	const pageSize = isNarrow() ? cfg.mobilePageSize : cfg.pageSize;

	const view = selectRows(rows, state, { pageSize });
	state.page = view.page;

	// The tbody is rebuilt wholesale, so the control you just activated is gone
	// by the time it would take focus back — pinning three people in a row threw
	// a keyboard user to the top of the document three times. Rows carry a stable
	// key, so the same control can be found again after the rebuild.
	const focusKey = el.tbody.contains(document.activeElement)
		? (document.activeElement.dataset.focusKey ?? null)
		: null;

	renderRows(view.rows);
	if (focusKey) refocus(focusKey);
	renderHint(view);
	renderPins();
	renderStats(view);

	el.pager.hidden = !view.paged;
	el.prev.disabled = view.page <= 1;
	el.next.disabled = view.page >= view.pages;
	el.pagerStatus.textContent = `page ${view.page}/${view.pages}`;

	// Off-bucket pins are named separately rather than folded into the total, so
	// the headline number still means "rows that match the current view".
	const pins = view.pinnedExtra > 0 ? ` · ${view.pinnedExtra} pinned` : "";
	el.count.textContent = view.paged
		? `(showing ${view.rows.length} of ${view.total}${pins})`
		: view.total === rows.length && view.pinnedExtra === 0
			? ""
			: `(showing ${view.total} of ${rows.length}${pins})`;

	for (const button of el.show.children) {
		button.setAttribute("aria-pressed", String(button.value === state.show));
	}
	for (const th of el.thead.querySelectorAll("th")) {
		const { key } = th.dataset;
		const active = key === state.sortKey;
		const label = key === "score" ? cfg.scoreLabel : key;
		th.classList.toggle("sorted", active);
		th.querySelector("button").textContent = active
			? `${label} ${state.sortDir === "asc" ? "↑" : "↓"}`
			: label;
		if (active) th.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending");
		else th.removeAttribute("aria-sort");
	}
	el.sortSelect.value = `${state.sortKey}:${state.sortDir}`;
	el.clearFilter.hidden = el.filter.value === "";
}

// Matched by value rather than by selector: the keys carry sheet text, which is
// free to contain quotes and brackets.
function refocus(key) {
	for (const node of el.tbody.querySelectorAll("[data-focus-key]")) {
		if (node.dataset.focusKey === key) {
			node.focus();
			return;
		}
	}
}

function renderRows(pageRows) {
	el.tbody.replaceChildren(
		...pageRows.flatMap((row) => {
			// Hosts keep a real rank and win rate; the note explains it is a playing
			// record, and the muted row keeps them visually apart. The visual note
			// reaches sighted readers two ways — a tooltip when wide, its own line
			// when narrow — so the cells carry it in their accessible name too, or
			// screen readers would get it at neither width.
			const note = (value) =>
				row.isHost
					? { title: cfg.hostPlayingNote, "aria-label": `${value}, ${cfg.hostPlayingNote}` }
					: {};
			const classes = (...names) => names.filter(Boolean).join(" ") || null;

			const pinned = state.pinned.has(row.id);

			const tr = h("tr", { class: classes(row.isHost && "host", pinned && "pinned") },
				h("td", { "data-label": "rank", ...note(row.rank ?? "unranked"),
					class: classes(row.rank === null && "muted", row.isHost && "noted") },
					row.rank ?? "—"),
				h("td", { "data-label": "initials" },
					h("button", { type: "button", class: "pin", "aria-pressed": String(pinned),
						"data-focus-key": `pin:${row.id}`,
						title: pinned ? `unpin ${row.initials}` : `pin ${row.initials} to the top`,
						on: { click: () => togglePin(row.id) } }, row.initials),
					attendanceMark(row)),
				h("td", { "data-label": "country" }, ...countryLinks(row.country)),
				h("td", { "data-label": cfg.scoreLabel, ...note,
					class: classes(!row.hasScore && "muted", row.isHost && "noted") },
					row.hasScore ? row.scoreText : "—"),
				h("td", { "data-label": "status" }, row.statusText),
			);

			// Narrow screens have no hover, so the host note gets its own line. It
			// inherits `pinned` so the pinned block stays contiguous for the divider.
			return row.isHost
				? [tr, h("tr", { class: classes("host-note", pinned && "pinned"), "aria-hidden": "true" },
						h("td", { colspan: COLUMNS.length }, cfg.hostPlayingNote))]
				: [tr];
		}),
	);
}

const attendanceMark = ({ attendance }) =>
	attendance &&
	h("abbr", { class: "att", title: attendance.title, "aria-label": attendance.title },
		h("span", { "aria-hidden": "true" }, attendance.mark));

/** "U.K. / Finland" becomes two separate filter buttons, either of which finds them. */
const countryLinks = (row) =>
	row.country
		.split("/")
		.map((name) => name.trim())
		.filter(Boolean)
		.flatMap((name, i) => [
			...(i > 0 ? [" / "] : []),
			h("button", { type: "button", class: "country", title: `filter to ${name}`,
				"data-focus-key": `country:${row.id}:${name}`,
				on: { click: () => setQuery(name) } }, name),
		]);

function renderPins() {
	const count = state.pinned.size;
	el.pins.hidden = count === 0;
	if (count === 0) return;

	el.pins.replaceChildren(
		`${count} pinned `,
		h("button", { type: "button", class: "link",
			on: { click: () => { state.pinned.clear(); savePins(); render(); } } }, "clear"),
	);
}

// Stats describe what is currently on screen, not the whole sheet, so filtering
// to one country shows that country's shape.
function renderStats({ matching }) {
	el.stats.hidden = matching.length === 0;
	if (matching.length === 0) return;

	const { players, countries, median, min, max } = summarise(matching);
	const scored = matching.filter((row) => row.hasScore).length;

	el.statsSummary.textContent = [
		`${players} ${players === 1 ? "player" : "players"}`,
		`${countries} ${countries === 1 ? "country" : "countries"}`,
		...(scored > 0 ? [`median ${format(median)}`, `${format(min)}–${format(max)}`] : []),
	].join(" · ");

	// Bars are scaled to a fixed width; the count is printed after each one, so
	// no information is lost by not drawing one block per player.
	const bands = scoreBands(matching);
	const width = Math.max(...bands.map((b) => b.label.length), 0);
	const bars = barLengths(bands, MAX_BAR);
	el.histogram.textContent = bands
		.map(({ label, count }, i) =>
			`${label.padEnd(width)}  ${"█".repeat(bars[i])} ${count || ""}`.trimEnd())
		.join("\n");

	const { counts, dual } = countryCounts(matching);
	el.statsCountries.replaceChildren(
		...counts.flatMap(([name, n], i) => [
			...(i > 0 ? [" · "] : []),
			h("button", { type: "button", class: "country", title: `filter to ${name}`,
				on: { click: () => setQuery(name) } }, `${name} ${n}`),
		]),
	);

	el.statsNote.hidden = dual === 0;
	el.statsNote.textContent = dual === 0
		? ""
		: `${dual} ${dual === 1 ? "person is" : "people are"} counted under two countries, so the country counts total more than the number of players.`;
}

const format = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

function renderHint({ total, query }) {
	const wider =
		total === 0 && query && state.show !== "all"
			? rows.filter((row) => matches(row, query)).length
			: 0;

	el.hint.hidden = wider === 0;
	if (wider === 0) return;

	// The whole line is the control — a bare "all" link inside a muted sentence
	// was too easy to read straight past.
	el.hint.replaceChildren(
		h("button", { type: "button", class: "hint-action", on: { click: () => setShow("all") } },
			`no ${state.show} entries — show ${wider} match${wider === 1 ? "" : "es"} in all →`),
	);
}

// ─── controls ────────────────────────────────────────────────────────────────

function buildControls() {
	el.legend.replaceChildren(
		h("span", { class: "legend-line" }, cfg.provisionalLegend),
		...(Object.keys(cfg.attendance).length > 0
			? [h("span", { class: "legend-line" },
					Object.values(cfg.attendance)
						.map(({ mark, title }) => `${mark} ${title}`)
						.join("    "))]
			: []),
	);

	el.show.replaceChildren(
		...SHOW_VALUES.flatMap((value, i) => [
			...(i > 0 ? [" · "] : []),
			h("button", { type: "button", class: "show-link", value,
				on: { click: () => setShow(value) } }, value),
		]),
	);

	// One option per column per direction, so the select maps 1:1 onto state.
	el.sortSelect.replaceChildren(
		...COLUMNS.flatMap((key) =>
			["desc", "asc"].map((dir) =>
				h("option", { value: `${key}:${dir}` },
					`${key === "score" ? cfg.scoreLabel : key} ${dir === "desc" ? "↓" : "↑"}`),
			),
		),
	);
	el.sortSelect.addEventListener("change", () => {
		[state.sortKey, state.sortDir] = el.sortSelect.value.split(":");
		state.page = 1;
		render();
	});

	el.thead.addEventListener("click", ({ target }) => {
		const key = target.closest("th[data-key]")?.dataset.key;
		if (key) setSort(key);
	});

	el.prev.addEventListener("click", () => goToPage(state.page - 1));
	el.next.addEventListener("click", () => goToPage(state.page + 1));

	// Clearing a filter on a phone otherwise means selecting the text and finding
	// backspace; the native search field's own clear button isn't in every
	// browser and can't be made a 44px target.
	el.clearFilter.addEventListener("click", () => {
		setQuery("");
		el.filter.focus();
	});

	let debounce;
	el.filter.addEventListener("input", () => {
		el.clearFilter.hidden = el.filter.value === "";
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			state.query = el.filter.value;
			state.page = 1;
			render();
		}, FILTER_DEBOUNCE_MS);
	});

	// Pagination is layout-dependent, so re-render when the table crosses the
	// breakpoint — not on every resize tick.
	let narrow = isNarrow();
	new ResizeObserver(() => {
		if (isNarrow() === narrow) return;
		narrow = !narrow;
		state.page = 1;
		render();
	}).observe(board);
}

function setSort(key) {
	if (state.sortKey === key) {
		state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
	} else {
		state.sortKey = key;
		state.sortDir = SORTS[key].dir;
	}
	state.page = 1;
	render();
}

function setShow(value) {
	state.show = value;
	state.page = 1;
	render();
}

function setQuery(value) {
	el.filter.value = value;
	state.query = value;
	state.page = 1;
	render();
}

function togglePin(id) {
	if (!state.pinned.delete(id)) state.pinned.add(id);
	savePins();
	state.page = 1; // a newly pinned row belongs on the first page
	render();
}

function goToPage(page) {
	state.page = page;
	render();
	scrollTo({ top: 0 });
}

// ─── states ──────────────────────────────────────────────────────────────────

function showMessage(text) {
	Object.assign(el.message, { hidden: false, className: "message", textContent: text });
	for (const node of [el.controls, el.table, el.pager, el.hint, el.stats]) node.hidden = true;
	el.count.textContent = "";
}

function showError(error) {
	if (!(error instanceof AppError)) console.error(error);
	showMessage(
		error instanceof AppError ? error.message : "something went wrong loading the leaderboard",
	);

	el.message.className = "message error";
	el.message.append(" ", h("button", { type: "button", class: "link", on: { click: boot } }, "retry"));
}

// ─── utils ───────────────────────────────────────────────────────────────────

/** Minimal element builder: h(tag, { class, on, ...attrs }, ...children). */
function h(tag, { on, ...attrs } = {}, ...children) {
	const node = document.createElement(tag);

	for (const [name, value] of Object.entries(attrs)) {
		if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value);
	}
	for (const [type, listener] of Object.entries(on ?? {})) node.addEventListener(type, listener);

	node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
	return node;
}

boot();
