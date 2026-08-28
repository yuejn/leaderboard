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
	hosts: (r) => r.isHost,
};

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

	const strings = ["scoreLabel", "provisionalLegend", "hostLabel", "hostSeparator",
		"hostPlayingNote", "quizmasterLabel"];
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
			id: Number.isNaN(id) ? i : id,
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

export function makeCompare({ sortKey, sortDir }) {
	const { tail, cmp } = SORTS[sortKey];
	const direction = sortDir === "asc" ? 1 : -1;

	return (a, b) => {
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
 */
export function selectRows(rows, state, { pageSize }) {
	const query = state.query.trim().toLowerCase();
	const matching = rows.filter((row) => MATCHERS[state.show](row) && matches(row, query));
	const sorted = matching.toSorted(makeCompare(state));

	if (!pageSize) {
		return { rows: sorted, total: sorted.length, pages: 1, page: 1, paged: false, query };
	}

	const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
	const page = Math.min(Math.max(state.page, 1), pages);
	const start = (page - 1) * pageSize;

	return {
		rows: sorted.slice(start, start + pageSize),
		total: sorted.length,
		pages,
		page,
		paged: true,
		query,
	};
}
