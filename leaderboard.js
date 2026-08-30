/**
 * Pure data layer: config validation, CSV parsing, ranking, filtering, sorting.
 * No DOM, no fetch — everything here is a plain function over plain data, so it
 * can be exercised outside a browser.
 */

export const COLUMNS = ["rank", "initials", "country", "score", "status"];
export const SHOW_VALUES = ["ranked", "all", "provisional", "hosts"];

const REQUIRED_COLUMNS = ["Initials", "Country", "Score", "Status"];

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Per-column sort behaviour. `tail` rows sort last regardless of direction. */
export const SORTS = {
	rank: { dir: "asc", tail: (r) => r.rank === null, cmp: (a, b) => a.rank - b.rank },
	score: { dir: "desc", tail: (r) => !r.hasScore, cmp: (a, b) => a.scoreNum - b.scoreNum },
	initials: { dir: "asc", cmp: (a, b) => collator.compare(a.initials, b.initials) },
	country: { dir: "asc", cmp: (a, b) => collator.compare(a.country, b.country) },
	status: { dir: "asc", cmp: (a, b) => collator.compare(a.statusText, b.statusText) },
};

const MATCHERS = {
	all: () => true,
	ranked: (r) => r.isRanked,
	provisional: (r) => r.isProvisional,
	// Everyone who has ever hosted, not just those over `hostedThreshold`. The
	// threshold decides who is *marked* a host in the standings, which is a
	// judgement about how much of their record is missing; the hosts view is a
	// roster, and leaving out someone who hosted once makes it a wrong one.
	hosts: (r) => r.hasHosted,
};

export const matchesShow = (row, show) => MATCHERS[show](row);

export class AppError extends Error {
	name = "AppError";
}

// ─── config ──────────────────────────────────────────────────────────────────

export function validateConfig(c) {
	const fail = (key, why) => {
		throw new AppError(`config.json: ${key} ${why}`);
	};
	const isInt = (v, min) => Number.isInteger(v) && v >= min;
	const isText = (v) => typeof v === "string" && v.trim() !== "";

	if (!isText(c?.csvUrl)) fail("csvUrl", "must be a non-empty string");
	for (const key of ["pageSize", "mobilePageSize"]) {
		if (!isInt(c[key], 0)) fail(key, "must be 0 (no pagination) or a positive integer");
	}
	if (!isInt(c.hostedThreshold, 0)) fail("hostedThreshold", "must be a non-negative integer");
	if (!isInt(c.refreshMinutes, 0)) {
		fail("refreshMinutes", "must be 0 (never re-read the sheet) or a positive integer");
	}

	const strings = ["scoreLabel", "provisionalLegend", "hostLabel", "hostSeparator",
		"hostPlayingNote", "hostedCountLabel", "quizmasterLabel", "playersNote", "updatedLabel"];
	for (const key of strings) {
		if (!isText(c[key])) fail(key, "must be a non-empty string");
	}

	if (!Array.isArray(c.quizmasterIds) || !c.quizmasterIds.every((id) => isInt(id, 0))) {
		fail("quizmasterIds", "must be an array of sheet ID numbers");
	}

	if (c.attendance === null || typeof c.attendance !== "object") {
		fail("attendance", "must be an object");
	}
	for (const [tier, entry] of Object.entries(c.attendance)) {
		if (!isText(entry?.mark) || !isText(entry?.title)) {
			fail(`attendance["${tier}"]`, "must have non-empty mark and title strings");
		}
	}

	if (!SHOW_VALUES.includes(c.defaultShow)) {
		fail("defaultShow", `must be one of ${SHOW_VALUES.join(" / ")}`);
	}
	if (!COLUMNS.includes(c.defaultSort?.key)) {
		fail("defaultSort.key", `must be one of ${COLUMNS.join(" / ")}`);
	}
	if (!["asc", "desc"].includes(c.defaultSort.dir)) {
		fail("defaultSort.dir", 'must be "asc" or "desc"');
	}
	return c;
}

// ─── csv ─────────────────────────────────────────────────────────────────────

/**
 * Character-scanning CSV reader: quoted fields, embedded commas and newlines,
 * `""` escapes, and CRLF / CR / LF line endings.
 */
export function parseCsv(text) {
	const records = [];
	let record = [];
	let field = "";
	let quoted = false;

	const endField = () => {
		record.push(field);
		field = "";
	};
	const endRecord = () => {
		endField();
		records.push(record);
		record = [];
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (quoted) {
			if (char !== '"') field += char;
			else if (text[i + 1] === '"') (field += '"'), i++;
			else quoted = false;
			continue;
		}

		switch (char) {
			case '"':
				quoted = true;
				break;
			case ",":
				endField();
				break;
			case "\r":
				if (text[i + 1] === "\n") i++;
				endRecord();
				break;
			case "\n":
				endRecord();
				break;
			default:
				field += char;
		}
	}
	if (field !== "" || record.length > 0) endRecord();

	return records;
}

// ─── rows ────────────────────────────────────────────────────────────────────

export function parseRows(text, config, onWarn = console.warn) {
	const [header = [], ...body] = parseCsv(text);
	const quizmasters = new Set(config.quizmasterIds);

	// Map by header name, not position, so a reordered sheet still works.
	const index = new Map();
	header.forEach((name, i) => {
		const key = name.trim();
		if (key && !index.has(key)) index.set(key, i);
	});
	for (const name of REQUIRED_COLUMNS) {
		if (!index.has(name)) {
			throw new AppError(`the sheet is missing an expected column: "${name}"`);
		}
	}

	const rows = body.flatMap((record, i) => {
		const cell = (name) => record[index.get(name)]?.trim() ?? "";

		const initials = cell("Initials");
		if (!initials) return []; // trailing blank rows still carry a stray Hosted value

		const scoreText = cell("Score");
		const scoreNum = Number.parseFloat(scoreText.replace("%", ""));
		const status = cell("Status");
		const hosted = Number.parseInt(cell("Hosted"), 10) || 0;
		const id = Number.parseInt(cell("ID"), 10);

		const tier = cell("Attended");
		const attendance = tier ? (config.attendance[tier] ?? null) : null;
		if (tier && !attendance) {
			onWarn(`leaderboard: unknown Attended value "${tier}" (row ${i + 2})`);
		}

		// Only a real ID can name a quizmaster — never the positional fallback,
		// or a sheet with no ID column would crown whoever sits at that index.
		const isQuizmaster = !Number.isNaN(id) && quizmasters.has(id);
		const isHost = isQuizmaster || hosted >= config.hostedThreshold;
		const hasHosted = isQuizmaster || hosted > 0;

		// Hosting annotates the competitor status rather than replacing it, so a
		// ranked host still reads as ranked. A quizmaster isn't really competing,
		// so the status is dropped entirely — "Provisional" would describe games
		// played and read as "newcomer", which is backwards for them.
		const label = status || "—";
		const statusText = isQuizmaster
			? config.quizmasterLabel
			: isHost
				? `${label}${config.hostSeparator}${config.hostLabel}`
				: label;

		return {
			// A row with no usable ID gets a negative synthetic one. Positional
			// indices collided with real sheet IDs — a blank-ID row at body index
			// 26 became id 26 — which crossed pins and the sort tiebreak between
			// two unrelated people.
			id: Number.isNaN(id) ? -(i + 1) : id,
			initials,
			country: cell("Country"),
			scoreText,
			scoreNum,
			hasScore: scoreText !== "" && !Number.isNaN(scoreNum),
			status,
			statusText,
			isRanked: status.toLowerCase() === "ranked",
			isProvisional: status.toLowerCase() === "provisional",
			hosted,
			isHost,
			hasHosted,
			isQuizmaster,
			attendance,
			rank: null,
		};
	});

	assignRanks(rows);
	return rows;
}

/** Competition ranking (1, 2, 2, 4) over scored Ranked rows, hosts included. */
export function assignRanks(rows) {
	const ranked = rows
		.filter((row) => row.isRanked && row.hasScore)
		.sort((a, b) => b.scoreNum - a.scoreNum || a.id - b.id);

	let rank = 0;
	let previous = null;
	for (const [i, row] of ranked.entries()) {
		if (row.scoreNum !== previous) {
			rank = i + 1;
			previous = row.scoreNum;
		}
		row.rank = rank;
	}
	return rows;
}

// ─── view ────────────────────────────────────────────────────────────────────

export const matches = (row, query) =>
	!query ||
	row.initials.toLowerCase().includes(query) ||
	row.country.toLowerCase().includes(query);

export function makeCompare({ sortKey, sortDir, pinned }) {
	const { tail, cmp } = SORTS[sortKey];
	const direction = sortDir === "asc" ? 1 : -1;

	return (a, b) => {
		// Pinned rows float to the top of whatever is showing, in every sort and
		// direction. They are not exempt from filters: pinning is a highlight, not
		// an override, so a pinned row the current view excludes stays excluded.
		if (pinned?.size) {
			const [pinnedA, pinnedB] = [pinned.has(a.id), pinned.has(b.id)];
			if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;
		}
		if (tail) {
			const [tailA, tailB] = [tail(a), tail(b)];
			if (tailA !== tailB) return tailA ? 1 : -1; // unranked / unscored always last
			if (tailA) return a.id - b.id;
		}
		return cmp(a, b) * direction || a.id - b.id;
	};
}

/**
 * Filter → sort → paginate. Returns the page slice plus the clamped page number;
 * callers are responsible for writing the clamped value back to their state.
 *
 * `pageSize: 0` turns pagination off and returns every matching row.
 *
 * Pins outrank the `show:` bucket but not the search box. A bucket is a view
 * mode you set once and leave, so hiding your pinned people behind it defeats
 * the point of pinning; the filter box is an active search, where a pinned row
 * you didn't ask for is just noise.
 */
export function selectRows(rows, state, { pageSize }) {
	const query = state.query.trim().toLowerCase();
	const pinned = state.pinned ?? new Set();

	const searched = rows.filter((row) => matches(row, query));
	const matching = searched.filter((row) => MATCHERS[state.show](row));
	const offBucket = searched.filter((row) => pinned.has(row.id) && !MATCHERS[state.show](row));

	// Pinned rows sort to the front, so off-bucket ones land on the first page.
	const shown = [...matching, ...offBucket].sort(makeCompare(state));

	const view = {
		matching, // bucket matches only — what `total` and the stats describe
		total: matching.length,
		pinnedExtra: offBucket.length,
		query,
	};

	if (!pageSize) return { ...view, rows: shown, pages: 1, page: 1, paged: false };

	const pages = Math.max(1, Math.ceil(shown.length / pageSize));
	const page = Math.min(Math.max(state.page, 1), pages);
	const start = (page - 1) * pageSize;

	return { ...view, rows: shown.slice(start, start + pageSize), pages, page, paged: true };
}

// ─── stats ───────────────────────────────────────────────────────────────────

/**
 * Players per country, most first. Someone recorded as "U.K. / Finland" counts
 * once for each, so the counts can total more than the number of people —
 * `dual` says how many rows that applies to.
 */
export function countryCounts(rows) {
	const counts = new Map();
	let dual = 0;

	for (const row of rows) {
		const names = row.country.split("/").map((name) => name.trim()).filter(Boolean);
		if (names.length > 1) dual++;
		for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	}

	return {
		counts: [...counts].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])),
		dual,
	};
}

/** Scores grouped into bands, highest first. Empty bands inside the range are kept. */
export function scoreBands(rows, size = 10) {
	const bands = new Map();
	for (const row of rows.filter((r) => r.hasScore)) {
		const floor = Math.floor(row.scoreNum / size) * size;
		bands.set(floor, (bands.get(floor) ?? 0) + 1);
	}
	if (bands.size === 0) return [];

	const floors = [...bands.keys()];
	const out = [];
	for (let floor = Math.max(...floors); floor >= Math.min(...floors); floor -= size) {
		out.push({ floor, label: `${floor}–${floor + size - 1}%`, count: bands.get(floor) ?? 0 });
	}
	return out;
}

/**
 * Bar lengths for the histogram, scaled so the tallest band is `max` blocks.
 * Unscaled bars ran off the side of a narrow screen once a band held twenty-odd
 * players. Any non-empty band keeps at least one block, so a band that has
 * someone in it never looks empty.
 */
export function barLengths(bands, max = 24) {
	const peak = Math.max(0, ...bands.map((band) => band.count));
	if (peak === 0) return bands.map(() => 0);

	const scale = Math.min(1, max / peak);
	return bands.map(({ count }) => (count === 0 ? 0 : Math.max(1, Math.round(count * scale))));
}

export function summarise(rows) {
	const scores = rows.filter((r) => r.hasScore).map((r) => r.scoreNum).sort((a, b) => a - b);
	const { counts, dual } = countryCounts(rows);

	const mid = scores.length / 2;
	const median = scores.length === 0
		? null
		: scores.length % 2 === 1
			? scores[Math.floor(mid)]
			: (scores[mid - 1] + scores[mid]) / 2;

	return {
		players: rows.length,
		countries: counts.length,
		dual,
		median,
		min: scores.at(0) ?? null,
		max: scores.at(-1) ?? null,
	};
}
