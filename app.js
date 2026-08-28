import {
	AppError,
	COLUMNS,
	SHOW_VALUES,
	SORTS,
	parseRows,
	matches,
	selectRows,
	validateConfig,
} from "./leaderboard.js";

const CONFIG_URL = "./config.json";
const FILTER_DEBOUNCE_MS = 150;
const FETCH_TIMEOUT_MS = 15_000;

/** Must match the `@container board (width < …)` breakpoint in style.css. */
const NARROW_WIDTH = 520;

const board = document.querySelector("main");
const isNarrow = () => board.clientWidth < NARROW_WIDTH;

const el = Object.fromEntries(
	[
		"meta", "message", "controls", "filter", "show", "legend", "table", "thead",
		"tbody", "hint", "pager", "prev", "next", "pager-status", "count", "sort-select",
	].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), document.getElementById(id)]),
);

let cfg = null;
let rows = [];
let built = false;
const state = { sortKey: "score", sortDir: "desc", show: "all", query: "", page: 1 };

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

	renderRows(view.rows);
	renderHint(view);

	el.pager.hidden = !view.paged;
	el.prev.disabled = view.page <= 1;
	el.next.disabled = view.page >= view.pages;
	el.pagerStatus.textContent = `page ${view.page}/${view.pages}`;

	// Paginated: how much of the match is on screen. Unpaginated: how much of the
	// sheet is in view at all — and nothing when that's all of it.
	el.count.textContent = view.paged
		? `(showing ${view.rows.length} of ${view.total})`
		: view.total === rows.length
			? ""
			: `(showing ${view.total} of ${rows.length})`;

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
}

function renderRows(pageRows) {
	el.tbody.replaceChildren(
		...pageRows.flatMap((row) => {
			// Hosts keep a real rank and win rate; the note explains it is a playing
			// record, and the muted row keeps them visually apart.
			const note = row.isHost ? { title: cfg.hostPlayingNote } : {};
			const classes = (...names) => names.filter(Boolean).join(" ") || null;

			const tr = h("tr", { class: row.isHost ? "host" : null },
				h("td", { "data-label": "rank", ...note,
					class: classes(row.rank === null && "muted", row.isHost && "noted") },
					row.rank ?? "—"),
				h("td", { "data-label": "initials" }, row.initials, attendanceMark(row)),
				h("td", { "data-label": "country" }, row.country),
				h("td", { "data-label": cfg.scoreLabel, ...note,
					class: classes(!row.hasScore && "muted", row.isHost && "noted") },
					row.hasScore ? row.scoreText : "—"),
				h("td", { "data-label": "status" }, row.statusText),
			);

			// Narrow screens have no hover, so the host note gets its own line.
			return row.isHost
				? [tr, h("tr", { class: "host-note", "aria-hidden": "true" },
						h("td", { colspan: COLUMNS.length }, cfg.hostPlayingNote))]
				: [tr];
		}),
	);
}

const attendanceMark = ({ attendance }) =>
	attendance &&
	h("abbr", { class: "att", title: attendance.title, "aria-label": attendance.title },
		h("span", { "aria-hidden": "true" }, attendance.mark));

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

	let debounce;
	el.filter.addEventListener("input", () => {
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

function goToPage(page) {
	state.page = page;
	render();
	scrollTo({ top: 0 });
}

// ─── states ──────────────────────────────────────────────────────────────────

function showMessage(text) {
	Object.assign(el.message, { hidden: false, className: "message", textContent: text });
	for (const node of [el.controls, el.table, el.pager, el.hint]) node.hidden = true;
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
