import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { Database, parameterShape, resultCodeName } from "./sqlite.js";

/** What `fn` threw, so a spec can read its fields. */
function thrown(fn: () => unknown): Error & Record<string, unknown> {
	try {
		fn();
	} catch (error) {
		return error as Error & Record<string, unknown>;
	}
	throw new Error("expected it to throw");
}

// What node:sqlite does on the Node this repository pins, where storage/sqlite.ts
// relies on it or works around it. node:sqlite is a release candidate and still
// changes between minor versions (#893): when one of these fails after a Node
// bump, the comment beside it says what to change in the adapter.
describe("node:sqlite on the pinned Node", () => {
	it("is built thread-safe", () => {
		// The spool checkpoint worker (storage/spool-checkpointer.ts) opens its own
		// connection on another thread, so SQLite must not be built with THREADSAFE=0;
		// each thread owning its connection, 1 or 2 both do.
		const db = new DatabaseSync(":memory:");
		try {
			const options = db
				.prepare("PRAGMA compile_options")
				.all()
				.map((row) => String(row.compile_options));
			expect(options.filter((option) => option.startsWith("THREADSAFE="))).toEqual([
				expect.stringMatching(/^THREADSAFE=[12]$/),
			]);
		} finally {
			db.close();
		}
	});

	it("loads without an ExperimentalWarning", () => {
		// Stability 1.2 since 24.15.0 prints none; 24.14 still did. The control
		// warning proves the child prints warnings at all.
		const script = [
			"const { DatabaseSync } = require('node:sqlite');",
			"new DatabaseSync(':memory:').close();",
			"process.emitWarning('control', 'ExperimentalWarning');",
		].join(" ");
		const child = spawnSync(process.execPath, ["-e", script], {
			encoding: "utf8",
			env: { ...process.env, NODE_OPTIONS: undefined, NODE_NO_WARNINGS: undefined },
		});
		expect(child.status, child.stderr).toBe(0);
		expect(child.stderr.match(/ExperimentalWarning: .*/g)).toEqual([
			"ExperimentalWarning: control",
		]);
	});

	it("exports DatabaseSync and StatementSync, as Database and Statement too", async () => {
		// Renamed in 26.11 (DEP0210, DEP0211, documentation-only): the new names are the
		// same classes. storage/sqlite.ts and the spool checkpoint worker import
		// DatabaseSync; if it goes, move both to what replaced it. Moving them to Database
		// waits for @types/node to declare it (26.6.6 does not).
		const sqlite: Record<string, unknown> = await import("node:sqlite");
		expect(typeof sqlite.DatabaseSync).toBe("function");
		expect(typeof sqlite.StatementSync).toBe("function");
		expect(sqlite.Database).toBe(sqlite.DatabaseSync);
		expect(sqlite.Statement).toBe(sqlite.StatementSync);
	});

	it("binds NULL for a parameter left out, without a word", () => {
		// better-sqlite3 refused it, and the adapter still does: see "refuses a
		// parameter left out" below.
		const db = new DatabaseSync(":memory:");
		try {
			expect(db.prepare("SELECT ? AS a, ? AS b").get(1)).toEqual({ a: 1, b: null });
			expect(db.prepare("SELECT @a AS a, @b AS b").get({ a: 1 })).toEqual({ a: 1, b: null });
		} finally {
			db.close();
		}
	});

	it("binds a boolean as 1 or 0, which the adapter refuses, as better-sqlite3 did", () => {
		// Since 24.21 and 26.8. The DAL writes 1 and 0 itself.
		const db = new DatabaseSync(":memory:");
		try {
			expect(db.prepare("SELECT ? AS t, ? AS f").get(true as never, false as never)).toEqual({
				t: 1,
				f: 0,
			});
		} finally {
			db.close();
		}
	});

	it("throws on an integer past 2^53 rather than round it", () => {
		// better-sqlite3 rounded it. The hub's largest integers are rowids, byte
		// sizes and millisecond times, far below; the adapter leaves it as it is.
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("CREATE TABLE t (n INTEGER)");
			db.prepare("INSERT INTO t VALUES (?), (?)").run(2 ** 53 - 1, 2n ** 53n + 1n);
			const read = db.prepare("SELECT n FROM t WHERE rowid = ?");
			expect(read.get(1)).toEqual({ n: Number.MAX_SAFE_INTEGER });
			expect(thrown(() => read.get(2))).toMatchObject({
				name: "RangeError",
				code: "ERR_OUT_OF_RANGE",
			});
		} finally {
			db.close();
		}
	});

	it("throws an SQLite error as an Error with ERR_SQLITE_ERROR, its result code in errcode", () => {
		// The adapter names that code in `code`, as better-sqlite3 did.
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("CREATE TABLE t (name TEXT UNIQUE)");
			db.exec("INSERT INTO t VALUES ('a')");
			const error = thrown(() => db.exec("INSERT INTO t VALUES ('a')"));
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({
				code: "ERR_SQLITE_ERROR",
				errcode: 2067,
				errstr: "constraint failed",
				message: "UNIQUE constraint failed: t.name",
			});
		} finally {
			db.close();
		}
	});

	it("reads a BLOB as a Uint8Array, in a row with no prototype", () => {
		// The adapter makes the row a plain object and the BLOB a Buffer.
		const db = new DatabaseSync(":memory:");
		try {
			const row = db.prepare("SELECT x'6869' AS b").get() as { b: Uint8Array };
			expect(Object.getPrototypeOf(row)).toBeNull();
			expect(row.b).toBeInstanceOf(Uint8Array);
			expect(Buffer.isBuffer(row.b)).toBe(false);
		} finally {
			db.close();
		}
	});
});

describe("Database", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(
			"CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, b BLOB, n INTEGER)",
		);
	});

	afterEach(() => {
		db.close();
	});

	const names = () =>
		(db.prepare("SELECT name FROM t ORDER BY id").all() as Array<{ name: string }>).map(
			(row) => row.name,
		);

	describe("statements", () => {
		it("runs, gets and reads all, with positional and named parameters", () => {
			const insert = db.prepare("INSERT INTO t (name, n) VALUES (?, ?)");
			expect(insert.run("a", 1)).toEqual({ changes: 1 });
			expect(
				db.prepare("INSERT INTO t (name, n) VALUES (@name, @n)").run({ name: "b", n: 2 }),
			).toEqual({ changes: 1 });
			expect(db.prepare("SELECT name, n FROM t WHERE n = ?").get(2)).toEqual({ name: "b", n: 2 });
			expect(db.prepare("SELECT name FROM t WHERE n = ?").get(3)).toBeUndefined();
			expect(db.prepare("SELECT name, n FROM t ORDER BY n").all()).toEqual([
				{ name: "a", n: 1 },
				{ name: "b", n: 2 },
			]);
			expect(db.prepare("UPDATE t SET n = n + 1").run()).toEqual({ changes: 2 });
		});

		it("takes named and positional parameters together, the object anywhere", () => {
			expect(
				db.prepare("SELECT @a AS a, ? AS b, :c AS c, $d AS d").get(2, { a: 1, c: 3, d: 4 }),
			).toEqual({ a: 1, b: 2, c: 3, d: 4 });
		});

		it("returns rows as plain objects", () => {
			db.prepare("INSERT INTO t (name) VALUES (?)").run("a");
			const row = db.prepare("SELECT name FROM t").get();
			expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
			for (const each of db.prepare("SELECT name FROM t").all()) {
				expect(Object.getPrototypeOf(each)).toBe(Object.prototype);
			}
		});

		// channel-lifecycle-manager.ts reads a snapshot's data with toString("utf8"),
		// which on node:sqlite's Uint8Array gives "123,34,…" instead of the text.
		it("reads a BLOB back as a Buffer over the bytes stored", () => {
			const snapshot = Buffer.from(JSON.stringify({ serialized: "é\u001b[0m", cols: 80 }));
			db.prepare("INSERT INTO t (name, b) VALUES (?, ?)").run("s", snapshot);
			const { b } = db.prepare("SELECT b FROM t").get() as { b: Buffer };
			expect(Buffer.isBuffer(b)).toBe(true);
			expect(b.equals(snapshot)).toBe(true);
			expect(b.toString("utf8")).toBe(snapshot.toString("utf8"));
			const [all] = db.prepare("SELECT b FROM t").all() as Array<{ b: Buffer }>;
			expect(Buffer.isBuffer(all?.b)).toBe(true);
		});

		it("binds a Uint8Array as a BLOB, and a bigint as an integer", () => {
			db.prepare("INSERT INTO t (name, b, n) VALUES (?, ?, ?)").run(
				"u",
				new Uint8Array([1, 2]),
				42n,
			);
			expect(db.prepare("SELECT b, n FROM t").get()).toEqual({ b: Buffer.from([1, 2]), n: 42 });
		});

		it("binds undefined as NULL, positional or named", () => {
			db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").run("a", undefined);
			db.prepare("INSERT INTO t (name, n) VALUES (@name, @n)").run({ name: "b", n: undefined });
			expect(db.prepare("SELECT n FROM t").all()).toEqual([{ n: null }, { n: null }]);
		});

		// Mutation caught: passing the parameters to node:sqlite unchecked, which
		// binds NULL in the place of the one left out.
		it("refuses a parameter left out", () => {
			expect(() => db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").run("a")).toThrow(
				new RangeError("Too few parameter values were provided"),
			);
			expect(() =>
				db.prepare("INSERT INTO t (name, n) VALUES (@name, @n)").run({ name: "a" }),
			).toThrow(new RangeError('Missing named parameter "n"'));
			expect(() => db.prepare("SELECT @a AS a").get()).toThrow(
				new RangeError('Missing named parameter "a"'),
			);
			// A key with its prefix is not the parameter, as better-sqlite3 had it.
			expect(() => db.prepare("SELECT @a AS a").get({ "@a": 1 })).toThrow(
				new RangeError('Missing named parameter "a"'),
			);
			expect(names()).toEqual([]);
		});

		it("refuses a parameter too many", () => {
			expect(() => db.prepare("SELECT ? AS a").get(1, 2)).toThrow(
				new RangeError("Too many parameter values were provided"),
			);
			expect(() => db.prepare("SELECT 1 AS a").get(1)).toThrow(
				new RangeError("Too many parameter values were provided"),
			);
		});

		it("ignores a named key the SQL does not use", () => {
			expect(db.prepare("SELECT @a AS a").get({ a: 1, extra: 2 })).toEqual({ a: 1 });
			expect(db.prepare("SELECT 1 AS a").get({ extra: 2 })).toEqual({ a: 1 });
		});

		it("refuses a value SQLite cannot store, booleans included, as better-sqlite3 did", () => {
			const select = db.prepare("SELECT ? AS a");
			class Point {
				x = 1;
			}
			for (const value of [true, new Date(), [1], new Point(), new ArrayBuffer(1), () => 1]) {
				expect(() => select.get(value), String(value)).toThrow(
					new TypeError("SQLite3 can only bind numbers, strings, bigints, buffers, and null"),
				);
			}
			expect(() => db.prepare("SELECT @a AS a").get({ a: false })).toThrow(TypeError);
		});

		it("refuses named parameters in two objects", () => {
			expect(() => db.prepare("SELECT @a AS a, @b AS b").get({ a: 1 }, { b: 2 })).toThrow(
				new TypeError("You cannot specify named parameters in two different objects"),
			);
		});
	});

	describe("errors", () => {
		it("names the SQLite result code in `code`, and keeps node:sqlite's errcode and message", () => {
			db.prepare("INSERT INTO t (name) VALUES (?)").run("a");
			const unique = thrown(() => db.prepare("INSERT INTO t (name) VALUES (?)").run("a"));
			expect(unique).toMatchObject({
				code: "SQLITE_CONSTRAINT_UNIQUE",
				errcode: 2067,
				message: "UNIQUE constraint failed: t.name",
			});
			expect(thrown(() => db.prepare("INSERT INTO t (n) VALUES (1)").run())).toMatchObject({
				code: "SQLITE_CONSTRAINT_NOTNULL",
			});
			expect(thrown(() => db.prepare("SELEC 1"))).toMatchObject({
				code: "SQLITE_ERROR",
				message: 'near "SELEC": syntax error',
			});
			expect(thrown(() => db.exec("INSERT INTO nowhere VALUES (1)"))).toMatchObject({
				code: "SQLITE_ERROR",
				message: "no such table: nowhere",
			});
			expect(thrown(() => db.pragma("no_such_table_info(1"))).toMatchObject({
				code: "SQLITE_ERROR",
			});
		});

		it("names primary and extended result codes as sqlite3.h does", () => {
			expect(resultCodeName(1)).toBe("SQLITE_ERROR");
			expect(resultCodeName(5)).toBe("SQLITE_BUSY");
			expect(resultCodeName(517)).toBe("SQLITE_BUSY_SNAPSHOT");
			expect(resultCodeName(516)).toBe("SQLITE_ABORT_ROLLBACK");
			expect(resultCodeName(787)).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
			expect(resultCodeName(2067)).toBe("SQLITE_CONSTRAINT_UNIQUE");
			expect(resultCodeName(3091)).toBe("SQLITE_CONSTRAINT_DATATYPE");
			expect(resultCodeName(266)).toBe("SQLITE_IOERR_READ");
			expect(resultCodeName(8970)).toBe("SQLITE_IOERR_BADKEY");
			expect(resultCodeName(9226)).toBe("SQLITE_IOERR_CODEC");
			expect(resultCodeName(1544)).toBe("SQLITE_READONLY_DIRECTORY");
			// An extended code it does not know goes by its primary code.
			expect(resultCodeName(260)).toBe("SQLITE_ABORT");
			expect(resultCodeName(19 | (40 << 8))).toBe("SQLITE_CONSTRAINT");
			expect(resultCodeName(99)).toBe("SQLITE_UNKNOWN_99");
		});
	});

	describe("pragma", () => {
		it("returns the rows, or with simple, the first value", () => {
			expect(db.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
			db.pragma("cache_size = -8000");
			expect(db.pragma("cache_size", { simple: true })).toBe(-8000);
			expect(db.pragma("incremental_vacuum(4)", { simple: true })).toBeUndefined();
		});

		it("opens with better-sqlite3's busy timeout and foreign keys on", () => {
			expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		});
	});

	describe("transaction", () => {
		const insert = (name: string) => db.prepare("INSERT INTO t (name) VALUES (?)").run(name);

		it("commits what the function wrote, and returns its value", () => {
			const add = db.transaction((first: string, second: string) => {
				insert(first);
				insert(second);
				return "done";
			});
			expect(add("a", "b")).toBe("done");
			expect(names()).toEqual(["a", "b"]);
		});

		it("rolls back when the function throws, and throws that error", () => {
			const failure = new Error("stop");
			expect(() =>
				db.transaction(() => {
					insert("a");
					throw failure;
				})(),
			).toThrow(failure);
			expect(names()).toEqual([]);
			// No transaction is left open.
			db.transaction(() => insert("b"))();
			expect(names()).toEqual(["b"]);
		});

		it("rolls back only the inner one when a nested transaction throws", () => {
			db.transaction(() => {
				insert("outer");
				expect(() =>
					db.transaction(() => {
						insert("inner");
						throw new Error("inner");
					})(),
				).toThrow("inner");
				db.transaction(() => insert("again"))();
			})();
			expect(names()).toEqual(["outer", "again"]);
		});

		it("refuses a function that returns a promise, and rolls back", () => {
			expect(() =>
				db.transaction(() => {
					insert("a");
					return Promise.resolve();
				})(),
			).toThrow(new TypeError("Transaction function cannot return a promise"));
			expect(names()).toEqual([]);
		});

		// A deferred foreign key is checked at COMMIT, which then fails and leaves
		// the transaction open: the adapter must roll it back.
		it("rolls back when COMMIT fails", () => {
			db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
				CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`);
			expect(
				thrown(() => db.transaction(() => db.exec("INSERT INTO child VALUES (1)"))()),
			).toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
			expect(db.prepare("SELECT COUNT(*) AS n FROM child").get()).toEqual({ n: 0 });
			db.transaction(() => insert("after"))();
			expect(names()).toEqual(["after"]);
		});
	});

	describe("connection", () => {
		it("says its name and whether it is open, and closes once", () => {
			const other = new Database(":memory:");
			expect(other.name).toBe(":memory:");
			expect(other.open).toBe(true);
			other.close();
			expect(other.open).toBe(false);
			expect(() => other.close()).not.toThrow();
			expect(() => other.prepare("SELECT 1")).toThrow();
		});
	});
});

describe("Database on a file", () => {
	let dir: string;
	const opened: Database[] = [];
	const open = (...args: ConstructorParameters<typeof Database>) => {
		const db = new Database(...args);
		opened.push(db);
		return db;
	};

	beforeEach(() => {
		dir = makeTempDir("lasterm-sqlite-");
	});

	afterEach(async () => {
		for (const db of opened.splice(0)) db.close();
		await removeTempDir(dir);
	});

	it("keeps the file name it was given", () => {
		const file = join(dir, "named.db");
		expect(open(file).name).toBe(file);
	});

	// db.ts sets busy_timeout = 5000 (STORAGE.md § 2): a writer waits that long
	// for another connection's lock before it gives up with SQLITE_BUSY.
	it("waits busy_timeout for a lock, then throws SQLITE_BUSY", () => {
		const file = join(dir, "busy.db");
		const holder = open(file);
		holder.pragma("journal_mode = WAL");
		holder.exec("CREATE TABLE t (x)");
		holder.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (1)");

		const writer = open(file);
		writer.pragma("busy_timeout = 300");
		const started = performance.now();
		const error = thrown(() => writer.exec("INSERT INTO t VALUES (2)"));
		const waited = performance.now() - started;

		expect(error).toMatchObject({ code: "SQLITE_BUSY", errcode: 5, message: "database is locked" });
		// Mutation caught: a writer that does not wait, as with node:sqlite's own
		// default busy timeout of 0, throws at once.
		expect(waited).toBeGreaterThanOrEqual(200);
		holder.exec("COMMIT");
		writer.exec("INSERT INTO t VALUES (2)");
		expect(writer.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 2 });
	});

	it("opens read-only on request", () => {
		const file = join(dir, "readonly.db");
		open(file).exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
		const reader = open(file, { readonly: true });
		expect(reader.prepare("SELECT x FROM t").all()).toEqual([{ x: 1 }]);
		expect(thrown(() => reader.exec("INSERT INTO t VALUES (2)"))).toMatchObject({
			code: "SQLITE_READONLY",
		});
	});

	it("names the result code of a file it cannot open", () => {
		expect(thrown(() => open(join(dir, "missing", "x.db")))).toMatchObject({
			code: "SQLITE_CANTOPEN",
		});
	});
});

describe("parameterShape", () => {
	it("counts each ? and names each named parameter once", () => {
		expect(parameterShape("SELECT ? , ?, @a, :b, $c, @a")).toEqual({
			anonymous: 2,
			named: ["a", "b", "c"],
		});
	});

	// Mutation caught: a scan that counts the `?` and `@x` inside these, and
	// then refuses a statement given the parameters it really has.
	it("skips string literals, quoted identifiers and comments", () => {
		const sql = `SELECT '?' AS "a?", 'it''s @x' AS [b?], \`c:d\` -- ? @y
			/* :z ? */ , ? AS v, x$y FROM t WHERE e = @e`;
		expect(parameterShape(sql)).toEqual({ anonymous: 1, named: ["e"] });
	});

	it("refuses numbered parameters", () => {
		expect(() => parameterShape("SELECT ?1")).toThrow(TypeError);
	});
});
