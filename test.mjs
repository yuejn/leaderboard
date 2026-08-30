/**
 * Tests for the pure data layer. No DOM, no network, no dependencies:
 *
 *     node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	AppError,
	assignRanks,
	barLengths,
	countryCounts,
	makeCompare,
	matches,
	matchesShow,
	parseCsv,
	parseRows,
	scoreBands,
	selectRows,
	summarise,
	validateConfig,
} from "./leaderboard.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A valid config, shaped like the real config.json. */
const config = (overrides = {}) => ({
	csvUrl: "https://example.test/sheet.csv",
	pageSize: 0,
	mobilePageSize: 20,
	refreshMinutes: 10,
	playersNote: "total players all-time",
	updatedLabel: "updated",
	scoreLabel: "track record",
	provisionalLegend: "provisional = fewer than 4 quizzes played",
	hostedThreshold: 8,
	hostLabel: "host",
	hostSeparator: " · ",
	hostPlayingNote: "record from games played, not hosted",
	hostedCountLabel: "hosted",
	quizmasterIds: [26],
	quizmasterLabel: "quiz master",
	attendance: {
		"30%+": { mark: "+", title: "attends 30%+ of quizzes" },
		"60%+": { mark: "++", title: "attends 60%+ of quizzes" },
	},
	defaultShow: "ranked",
	defaultSort: { key: "score", dir: "desc" },
	...overrides,
});

const HEADER = "ID,Initials,Country,Score,Status,Hosted,Attended";

/** Builds a sheet with the real CRLF line endings. */
const sheet = (...lines) => [HEADER, ...lines].join("\r\n");

/** A row as the sheet writes it. */
const line = ({ id = "", initials = "", country = "", score = "", status = "", hosted = "", attended = "" } = {}) =>
	[id, initials, country, score, status, hosted, attended].join(",");

const state = (overrides = {}) => ({
	sortKey: "score",
	sortDir: "desc",
	show: "all",
	query: "",
	page: 1,
	pinned: new Set(),
	...overrides,
});

const initialsOf = (rows) => rows.map((row) => row.initials);
const byInitials = (rows, wanted) => rows.find((row) => row.initials === wanted);

// ─── parseCsv ────────────────────────────────────────────────────────────────

describe("parseCsv", () => {
	it("splits records and fields", () => {
		assert.deepEqual(parseCsv("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
	});

	it("handles CRLF, bare CR and LF line endings", () => {
		assert.deepEqual(parseCsv("a\r\nb\rc\nd"), [["a"], ["b"], ["c"], ["d"]]);
	});

	it("does not emit a phantom record for a trailing newline", () => {
		assert.deepEqual(parseCsv("a,b\r\n"), [["a", "b"]]);
	});

	it("keeps a trailing empty field", () => {
		assert.deepEqual(parseCsv("a,"), [["a", ""]]);
	});

	it("returns nothing for empty input", () => {
		assert.deepEqual(parseCsv(""), []);
	});

	it("keeps commas inside quoted fields", () => {
		assert.deepEqual(parseCsv('x,"a,b",y'), [["x", "a,b", "y"]]);
	});

	it("unescapes doubled quotes", () => {
		assert.deepEqual(parseCsv('"say ""hi"""'), [['say "hi"']]);
	});

	it("keeps newlines inside quoted fields", () => {
		assert.deepEqual(parseCsv('"a\nb",c'), [["a\nb", "c"]]);
	});

	it("reads a quoted field that ends the input", () => {
		assert.deepEqual(parseCsv('a,"b"'), [["a", "b"]]);
	});
});

// ─── validateConfig ──────────────────────────────────────────────────────────

describe("validateConfig", () => {
	it("returns a valid config unchanged", () => {
		const valid = config();
		assert.equal(validateConfig(valid), valid);
	});

	/** Every case names the offending key, so the page can say what to fix. */
	const rejects = {
		csvUrl: [{ csvUrl: "" }, { csvUrl: undefined }, { csvUrl: 7 }],
		pageSize: [{ pageSize: -1 }, { pageSize: 1.5 }, { pageSize: "10" }],
		mobilePageSize: [{ mobilePageSize: -1 }],
		hostedThreshold: [{ hostedThreshold: -1 }],
		refreshMinutes: [{ refreshMinutes: -1 }, { refreshMinutes: 0.5 }, { refreshMinutes: undefined }],
		hostedCountLabel: [{ hostedCountLabel: "" }],
		playersNote: [{ playersNote: "" }],
		updatedLabel: [{ updatedLabel: undefined }],
		scoreLabel: [{ scoreLabel: "   " }],
		quizmasterLabel: [{ quizmasterLabel: undefined }],
		quizmasterIds: [{ quizmasterIds: 26 }, { quizmasterIds: ["26"] }],
		attendance: [{ attendance: null }, { attendance: "none" }],
		'attendance["30%+"]': [{ attendance: { "30%+": { mark: "+" } } }],
		defaultShow: [{ defaultShow: "everyone" }],
		"defaultSort.key": [{ defaultSort: { key: "hosted", dir: "asc" } }, { defaultSort: undefined }],
		"defaultSort.dir": [{ defaultSort: { key: "score", dir: "down" } }],
	};

	for (const [key, cases] of Object.entries(rejects)) {
		for (const [i, overrides] of cases.entries()) {
			it(`rejects ${key} (${i + 1}) and names it`, () => {
				assert.throws(() => validateConfig(config(overrides)), (error) => {
					assert.ok(error instanceof AppError);
					assert.match(error.message, new RegExp(key.replace(/[.[\]"+$]/g, "\\$&")));
					return true;
				});
			});
		}
	}

	it("accepts an empty attendance map", () => {
		assert.doesNotThrow(() => validateConfig(config({ attendance: {} })));
	});

	it("accepts pageSize 0 as 'no pagination'", () => {
		assert.doesNotThrow(() => validateConfig(config({ pageSize: 0, mobilePageSize: 0 })));
	});

	it("accepts refreshMinutes 0 as 'never re-read'", () => {
		assert.doesNotThrow(() => validateConfig(config({ refreshMinutes: 0 })));
	});
});

// ─── parseRows ───────────────────────────────────────────────────────────────

describe("parseRows", () => {
	const parse = (text, overrides, onWarn = () => {}) =>
		parseRows(text, config(overrides), onWarn);

	it("maps columns by header name, not position", () => {
		const reordered = [
			"Status,Score,Initials,Hosted,Country,ID,Attended",
			"Ranked,56%,A.B.,0,U.K.,1,",
		].join("\r\n");

		const [row] = parse(reordered);
		assert.equal(row.initials, "A.B.");
		assert.equal(row.country, "U.K.");
		assert.equal(row.scoreNum, 56);
		assert.equal(row.id, 1);
	});

	it("throws naming a missing required column", () => {
		const text = "ID,Initials,Country,Status\r\n1,A.B.,U.K.,Ranked";
		assert.throws(() => parse(text), (error) => {
			assert.ok(error instanceof AppError);
			assert.match(error.message, /Score/);
			return true;
		});
	});

	it("drops trailing blank rows that still carry a Hosted value", () => {
		const text = sheet(
			line({ id: 1, initials: "A.B.", score: "56%", status: "Ranked" }),
			line({ hosted: 0 }),
			line({ hosted: 0 }),
		);
		assert.deepEqual(initialsOf(parse(text)), ["A.B."]);
	});

	it("strips the CRLF carriage return from the last column", () => {
		const text = sheet(
			line({ id: 1, initials: "A.B.", status: "Ranked", attended: "30%+" }),
			line({ id: 2, initials: "C.D.", status: "Ranked" }),
		);
		assert.equal(byInitials(parse(text), "A.B.").attendance.mark, "+");
	});

	it("reads a percentage score and flags a blank one", () => {
		const text = sheet(
			line({ id: 1, initials: "A.B.", score: "56%", status: "Ranked" }),
			line({ id: 2, initials: "C.D.", score: "", status: "Ranked" }),
			line({ id: 3, initials: "E.F.", score: "n/a", status: "Ranked" }),
		);
		const rows = parse(text);
		assert.equal(byInitials(rows, "A.B.").scoreNum, 56);
		assert.equal(byInitials(rows, "A.B.").hasScore, true);
		assert.equal(byInitials(rows, "C.D.").hasScore, false);
		assert.equal(byInitials(rows, "E.F.").hasScore, false);
	});

	it("appends the host label to the status rather than replacing it", () => {
		const text = sheet(
			line({ id: 1, initials: "A.B.", score: "56%", status: "Ranked", hosted: 9 }),
			line({ id: 2, initials: "C.D.", score: "60%", status: "Provisional", hosted: 9 }),
		);
		const rows = parse(text);
		assert.equal(byInitials(rows, "A.B.").statusText, "Ranked · host");
		assert.equal(byInitials(rows, "C.D.").statusText, "Provisional · host");
		assert.ok(rows.every((row) => row.isHost));
	});

	it("treats hosted counts below the threshold as ordinary players", () => {
		const text = sheet(line({ id: 1, initials: "A.B.", status: "Ranked", hosted: 7 }));
		const [row] = parse(text);
		assert.equal(row.isHost, false, "not marked a host in the standings");
		assert.equal(row.statusText, "Ranked", "and not labelled one");
	});

	it("still records that a sub-threshold host has hosted", () => {
		const text = sheet(
			line({ id: 1, initials: "A.B.", status: "Ranked", hosted: 1 }),
			line({ id: 2, initials: "C.D.", status: "Ranked", hosted: 0 }),
			line({ id: 3, initials: "E.F.", status: "Ranked", hosted: 9 }),
		);
		const rows = parse(text);
		assert.equal(byInitials(rows, "A.B.").hasHosted, true);
		assert.equal(byInitials(rows, "C.D.").hasHosted, false);
		assert.equal(byInitials(rows, "E.F.").hasHosted, true);
	});

	it("counts a quizmaster as having hosted even with no Hosted value", () => {
		const text = sheet(line({ id: 26, initials: "J.H.", status: "Provisional" }));
		assert.equal(parse(text)[0].hasHosted, true);
	});

	it("labels a quizmaster by ID, with no competitor status", () => {
		const text = sheet(line({ id: 26, initials: "J.H.", score: "40%", status: "Provisional" }));
		const [row] = parse(text);
		assert.equal(row.statusText, "quiz master");
		assert.equal(row.isQuizmaster, true);
		assert.equal(row.isHost, true);
	});

	it("never lets a synthetic ID be mistaken for a quizmaster", () => {
		// Without a real ID column this row would have fallen at index 26.
		const rows = parse(sheet(...Array.from({ length: 30 }, (_, i) =>
			line({ initials: `P${i}`, status: "Ranked" }))));

		assert.ok(rows.every((row) => !row.isQuizmaster));
		assert.ok(rows.every((row) => row.id < 0));
	});

	it("gives ID-less rows distinct IDs that cannot collide with real ones", () => {
		const text = sheet(
			line({ initials: "A.B.", status: "Ranked" }),
			line({ initials: "C.D.", status: "Ranked" }),
			line({ id: 1, initials: "E.F.", status: "Ranked" }),
		);
		const ids = parse(text).map((row) => row.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(!ids.some((id) => id >= 0 && id !== 1));
	});

	it("warns about an unknown Attended value and leaves the mark off", () => {
		const warnings = [];
		const text = sheet(line({ id: 1, initials: "A.B.", status: "Ranked", attended: "90%+" }));
		const [row] = parse(text, {}, (message) => warnings.push(message));

		assert.equal(row.attendance, null);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /90%\+/);
		assert.match(warnings[0], /row 2/); // sheet row, counting the header
	});

	it("shows an em dash for a blank status", () => {
		const text = sheet(line({ id: 1, initials: "A.B.", score: "10%" }));
		const [row] = parse(text);
		assert.equal(row.statusText, "—");
		assert.equal(row.isRanked, false);
		assert.equal(row.isProvisional, false);
	});

	it("reads the status case-insensitively", () => {
		const text = sheet(
			line({ id: 1, initials: "A.B.", status: "ranked" }),
			line({ id: 2, initials: "C.D.", status: "PROVISIONAL" }),
		);
		const rows = parse(text);
		assert.equal(byInitials(rows, "A.B.").isRanked, true);
		assert.equal(byInitials(rows, "C.D.").isProvisional, true);
	});

	it("returns no rows for a header-only sheet", () => {
		assert.deepEqual(parse(sheet()), []);
	});
});

// ─── assignRanks ─────────────────────────────────────────────────────────────

describe("assignRanks", () => {
	const player = (id, scoreNum, extra = {}) => ({
		id,
		scoreNum,
		hasScore: !Number.isNaN(scoreNum),
		isRanked: true,
		rank: null,
		...extra,
	});

	it("uses competition ranking: 1, 2, 2, 4", () => {
		const rows = [player(1, 70), player(2, 60), player(3, 60), player(4, 50)];
		assignRanks(rows);
		assert.deepEqual(rows.map((row) => row.rank), [1, 2, 2, 4]);
	});

	it("gives tied rows the same rank whatever their IDs", () => {
		const rows = [player(9, 60), player(1, 70), player(2, 60)];
		assignRanks(rows);
		assert.deepEqual(rows.map((row) => row.rank), [2, 1, 2]);
	});

	it("ranks hosts alongside everyone else", () => {
		const rows = [player(1, 70, { isHost: true }), player(2, 60)];
		assignRanks(rows);
		assert.deepEqual(rows.map((row) => row.rank), [1, 2]);
	});

	it("leaves provisional rows unranked", () => {
		const rows = [player(1, 90, { isRanked: false }), player(2, 60)];
		assignRanks(rows);
		assert.deepEqual(rows.map((row) => row.rank), [null, 1]);
	});

	it("leaves a ranked row with no score unranked rather than last", () => {
		const rows = [player(1, Number.NaN), player(2, 60), player(3, 50)];
		assignRanks(rows);
		assert.deepEqual(rows.map((row) => row.rank), [null, 1, 2]);
	});

	it("does not reorder the rows it is given", () => {
		const rows = [player(1, 50), player(2, 70)];
		assignRanks(rows);
		assert.deepEqual(rows.map((row) => row.id), [1, 2]);
	});
});

// ─── matching and sorting ────────────────────────────────────────────────────

describe("matches", () => {
	const row = { initials: "A.B.", country: "U.K. / Finland" };

	it("matches an empty query", () => assert.equal(matches(row, ""), true));
	it("matches on initials", () => assert.equal(matches(row, "a.b"), true));
	it("matches on country", () => assert.equal(matches(row, "finland"), true));
	it("rejects a miss", () => assert.equal(matches(row, "spain"), false));
});

describe("matchesShow", () => {
	const row = { isRanked: true, isProvisional: false, isHost: true, hasHosted: true };

	it("all matches everything", () => assert.equal(matchesShow(row, "all"), true));
	it("ranked matches a ranked row", () => assert.equal(matchesShow(row, "ranked"), true));
	it("provisional does not", () => assert.equal(matchesShow(row, "provisional"), false));
	it("hosts matches a host", () => assert.equal(matchesShow(row, "hosts"), true));

	it("hosts goes by having hosted, not by the host marking", () => {
		const once = { isRanked: true, isProvisional: false, isHost: false, hasHosted: true };
		assert.equal(matchesShow(once, "hosts"), true);
		assert.equal(matchesShow({ ...once, hasHosted: false }, "hosts"), false);
	});
});

describe("makeCompare", () => {
	const rows = () => [
		{ id: 1, initials: "C.D.", country: "Spain", scoreNum: 50, hasScore: true, rank: 2, statusText: "Ranked" },
		{ id: 2, initials: "A.B.", country: "U.K.", scoreNum: 70, hasScore: true, rank: 1, statusText: "Ranked" },
		{ id: 3, initials: "E.F.", country: "Finland", scoreNum: Number.NaN, hasScore: false, rank: null, statusText: "Provisional" },
	];

	const sorted = (overrides) => initialsOf(rows().sort(makeCompare(state(overrides))));

	it("sorts by score descending", () => {
		assert.deepEqual(sorted({ sortKey: "score", sortDir: "desc" }), ["A.B.", "C.D.", "E.F."]);
	});

	it("keeps unscored rows last even when reversed", () => {
		assert.deepEqual(sorted({ sortKey: "score", sortDir: "asc" }), ["C.D.", "A.B.", "E.F."]);
	});

	it("keeps unranked rows last in both directions", () => {
		assert.deepEqual(sorted({ sortKey: "rank", sortDir: "asc" }), ["A.B.", "C.D.", "E.F."]);
		assert.deepEqual(sorted({ sortKey: "rank", sortDir: "desc" }), ["C.D.", "A.B.", "E.F."]);
	});

	it("sorts text columns case-insensitively", () => {
		assert.deepEqual(sorted({ sortKey: "initials", sortDir: "asc" }), ["A.B.", "C.D.", "E.F."]);
		assert.deepEqual(sorted({ sortKey: "country", sortDir: "asc" }), ["E.F.", "C.D.", "A.B."]);
	});

	it("floats pinned rows to the top of every sort", () => {
		assert.deepEqual(sorted({ sortKey: "score", sortDir: "desc", pinned: new Set([1]) }),
			["C.D.", "A.B.", "E.F."]);
		assert.deepEqual(sorted({ sortKey: "score", sortDir: "asc", pinned: new Set([3]) }),
			["E.F.", "C.D.", "A.B."]);
	});
});

// ─── selectRows ──────────────────────────────────────────────────────────────

describe("selectRows", () => {
	const rows = parseRows(
		sheet(
			line({ id: 1, initials: "A.B.", country: "U.K.", score: "70%", status: "Ranked" }),
			line({ id: 2, initials: "C.D.", country: "Spain", score: "60%", status: "Ranked", hosted: 1 }),
			line({ id: 3, initials: "E.F.", country: "Finland", score: "80%", status: "Provisional" }),
			line({ id: 4, initials: "G.H.", country: "U.K.", score: "50%", status: "Ranked", hosted: 9 }),
		),
		config(),
		() => {},
	);

	const select = (overrides, pageSize = 0) => selectRows(rows, state(overrides), { pageSize });

	it("returns everything when show is all", () => {
		assert.equal(select({ show: "all" }).total, 4);
	});

	it("filters to the show bucket", () => {
		assert.deepEqual(initialsOf(select({ show: "ranked" }).rows), ["A.B.", "C.D.", "G.H."]);
		assert.deepEqual(initialsOf(select({ show: "provisional" }).rows), ["E.F."]);
	});

	it("shows every host, not just those over the threshold", () => {
		// C.D. has hosted once, G.H. nine times; only G.H. is marked a host.
		assert.deepEqual(initialsOf(select({ show: "hosts" }).rows), ["C.D.", "G.H."]);
	});

	it("searches initials and country, case-insensitively", () => {
		assert.deepEqual(initialsOf(select({ show: "all", query: "  U.K.  " }).rows), ["A.B.", "G.H."]);
		assert.deepEqual(initialsOf(select({ show: "all", query: "e.f" }).rows), ["E.F."]);
	});

	it("reports the trimmed, lowercased query back to the caller", () => {
		assert.equal(select({ query: "  Finland " }).query, "finland");
	});

	it("shows a pinned row that the show bucket excludes, and counts it apart", () => {
		const view = select({ show: "ranked", pinned: new Set([3]) });

		assert.deepEqual(initialsOf(view.rows), ["E.F.", "A.B.", "C.D.", "G.H."]);
		assert.equal(view.total, 3, "the headline count still means 'rows in this view'");
		assert.equal(view.pinnedExtra, 1);
		assert.deepEqual(initialsOf(view.matching), ["A.B.", "C.D.", "G.H."]);
	});

	it("does not let a pin override the search box", () => {
		const view = select({ show: "all", query: "spain", pinned: new Set([1]) });
		assert.deepEqual(initialsOf(view.rows), ["C.D."]);
		assert.equal(view.pinnedExtra, 0);
	});

	it("returns every row unpaged when pageSize is 0", () => {
		const view = select({ show: "all" }, 0);
		assert.equal(view.paged, false);
		assert.equal(view.pages, 1);
		assert.equal(view.rows.length, 4);
	});

	it("paginates and reports the page count", () => {
		const view = select({ show: "all" }, 3);
		assert.equal(view.paged, true);
		assert.equal(view.pages, 2);
		assert.equal(view.rows.length, 3);
	});

	it("clamps a page number past the end", () => {
		const view = select({ show: "all", page: 99 }, 3);
		assert.equal(view.page, 2);
		assert.deepEqual(initialsOf(view.rows), ["G.H."]);
	});

	it("clamps a page number below the start", () => {
		assert.equal(select({ show: "all", page: 0 }, 3).page, 1);
	});

	it("counts off-bucket pins towards the pages", () => {
		const view = select({ show: "provisional", pinned: new Set([1, 2]) }, 2);
		assert.equal(view.pages, 2);
		assert.equal(view.total, 1);
		assert.equal(view.pinnedExtra, 2);
	});

	it("reports an empty view rather than throwing", () => {
		const view = select({ show: "all", query: "nobody" }, 10);
		assert.deepEqual(view.rows, []);
		assert.equal(view.total, 0);
		assert.equal(view.pages, 1);
		assert.equal(view.page, 1);
	});
});

// ─── stats ───────────────────────────────────────────────────────────────────

describe("countryCounts", () => {
	const rows = (...countries) => countries.map((country) => ({ country }));

	it("counts players per country, most first", () => {
		const { counts } = countryCounts(rows("U.K.", "Spain", "U.K."));
		assert.deepEqual(counts, [["U.K.", 2], ["Spain", 1]]);
	});

	it("breaks count ties alphabetically", () => {
		const { counts } = countryCounts(rows("Spain", "Finland"));
		assert.deepEqual(counts.map(([name]) => name), ["Finland", "Spain"]);
	});

	it("counts a dual entry under both countries and reports it", () => {
		const { counts, dual } = countryCounts(rows("U.K. / Finland", "U.K."));
		assert.deepEqual(counts, [["U.K.", 2], ["Finland", 1]]);
		assert.equal(dual, 1);
	});

	it("ignores a blank country", () => {
		const { counts, dual } = countryCounts(rows("", "U.K."));
		assert.deepEqual(counts, [["U.K.", 1]]);
		assert.equal(dual, 0);
	});
});

describe("scoreBands", () => {
	const rows = (...scores) => scores.map((scoreNum) => ({ scoreNum, hasScore: true }));

	it("groups into bands of ten, highest first", () => {
		assert.deepEqual(scoreBands(rows(5, 12, 15)), [
			{ floor: 10, label: "10–19%", count: 2 },
			{ floor: 0, label: "0–9%", count: 1 },
		]);
	});

	it("keeps empty bands inside the range", () => {
		assert.deepEqual(scoreBands(rows(5, 25)).map((band) => band.count), [1, 0, 1]);
	});

	it("ignores unscored rows", () => {
		const mixed = [...rows(50), { scoreNum: Number.NaN, hasScore: false }];
		assert.deepEqual(scoreBands(mixed), [{ floor: 50, label: "50–59%", count: 1 }]);
	});

	it("returns nothing when no row has a score", () => {
		assert.deepEqual(scoreBands([{ scoreNum: Number.NaN, hasScore: false }]), []);
	});
});

describe("barLengths", () => {
	const bands = (...counts) => counts.map((count) => ({ count }));

	it("draws one block per player while the tallest band fits", () => {
		assert.deepEqual(barLengths(bands(3, 1, 0), 24), [3, 1, 0]);
	});

	it("scales down so the tallest band is exactly the maximum", () => {
		assert.deepEqual(barLengths(bands(48, 24, 0), 24), [24, 12, 0]);
	});

	it("never lets a band with someone in it round away to nothing", () => {
		const [tallest, ...rest] = barLengths(bands(100, 1, 1), 10);
		assert.equal(tallest, 10);
		assert.deepEqual(rest, [1, 1]);
	});

	it("keeps empty bands empty", () => {
		assert.deepEqual(barLengths(bands(0, 0)), [0, 0]);
	});

	it("handles no bands at all", () => {
		assert.deepEqual(barLengths([]), []);
	});
});

describe("summarise", () => {
	const scored = (...scores) =>
		scores.map((scoreNum) => ({ scoreNum, hasScore: true, country: "U.K." }));

	it("takes the middle value as the median of an odd count", () => {
		assert.equal(summarise(scored(10, 30, 50)).median, 30);
	});

	it("averages the middle pair for an even count", () => {
		assert.equal(summarise(scored(50, 60)).median, 55);
	});

	it("is order-independent", () => {
		assert.equal(summarise(scored(50, 10, 30)).median, 30);
	});

	it("reports the range and the player count", () => {
		const { players, min, max, countries } = summarise(scored(10, 30, 50));
		assert.deepEqual([players, min, max, countries], [3, 10, 50, 1]);
	});

	it("counts unscored players but leaves them out of the numbers", () => {
		const rows = [...scored(40), { scoreNum: Number.NaN, hasScore: false, country: "Spain" }];
		const { players, median, min, max, countries } = summarise(rows);
		assert.deepEqual([players, median, min, max, countries], [2, 40, 40, 40, 2]);
	});

	it("returns nulls rather than NaN when nothing is scored", () => {
		const { players, median, min, max } = summarise([{ scoreNum: Number.NaN, hasScore: false, country: "" }]);
		assert.deepEqual([players, median, min, max], [1, null, null, null]);
	});
});
