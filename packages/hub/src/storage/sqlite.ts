/**
 * The hub's SQLite connections, over Node's own `node:sqlite` (#893).
 *
 * The DAL was written against better-sqlite3, and this module gives it the
 * calls it uses, and only those: `prepare` with `run`, `get` and `all`, `exec`,
 * `pragma`, `transaction`, `close`, `open` and `name`. Where `node:sqlite`
 * behaves differently, the behaviour the DAL was written for is kept:
 *
 * - A missing parameter throws. `node:sqlite` binds NULL in its place, silently.
 * - A parameter is a number, a string, a bigint, a Buffer, null, or undefined
 *   for NULL, and a boolean is refused; both are settled here, before
 *   `node:sqlite` sees them. It binds a boolean as 1 or 0, and since 26.10
 *   undefined as NULL itself, but its types (`SQLInputValue`) still exclude
 *   undefined, so the mapping stays.
 * - Named parameters come in one plain object, keyed without their `@`, and a
 *   key the SQL does not name is ignored.
 * - A row is a plain object, and a BLOB a Buffer over the bytes read, not a copy.
 * - An SQLite error says its result code by name in `code`, such as
 *   `SQLITE_CONSTRAINT_UNIQUE`. `node:sqlite` says `ERR_SQLITE_ERROR` there,
 *   and gives the number in `errcode`, which is kept.
 *
 * `node:sqlite` is a release candidate (Stability 1.2) and still changes
 * between minor versions. The hub runs one exact Node, so a change arrives
 * with a bump, and `sqlite.spec.ts` pins what this module relies on.
 */
import {
	DatabaseSync,
	type SQLInputValue,
	type SQLOutputValue,
	type StatementSync,
} from "node:sqlite";

/** What `run` reports: the rows the statement changed. */
export interface RunResult {
	changes: number;
}

export interface DatabaseOptions {
	/** Open the file read-only. */
	readonly?: boolean;
}

/** The parameters a statement takes, read from its SQL. */
interface ParameterShape {
	/** How many `?` it has. */
	readonly anonymous: number;
	/** The names of its `@name`, `:name` and `$name` parameters, each once. */
	readonly named: readonly string[];
}

const IDENTIFIER_CHAR = /[\w\u0080-￿]/;

/**
 * The parameters in `sql`, skipping string literals, quoted identifiers and
 * comments, so that a `?` or an `@` inside one is not taken for a parameter.
 */
export function parameterShape(sql: string): ParameterShape {
	let anonymous = 0;
	const named = new Set<string>();
	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		if (char === "'" || char === '"' || char === "`") {
			// A doubled quote inside reads as the end of one literal and the start of
			// the next, which skips it all the same.
			const end = sql.indexOf(char, i + 1);
			if (end === -1) break;
			i = end;
		} else if (char === "[") {
			const end = sql.indexOf("]", i + 1);
			if (end === -1) break;
			i = end;
		} else if (char === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i + 2);
			if (end === -1) break;
			i = end;
		} else if (char === "/" && sql[i + 1] === "*") {
			const end = sql.indexOf("*/", i + 2);
			if (end === -1) break;
			i = end + 1;
		} else if (char === "?") {
			if (/\d/.test(sql[i + 1] ?? "")) {
				throw new TypeError("Numbered parameters (?NNN) are not supported");
			}
			anonymous++;
		} else if (
			(char === "@" || char === ":" || char === "$") &&
			// SQLite takes a `$` inside a name as part of it: `a$b` is one identifier.
			!IDENTIFIER_CHAR.test(sql[i - 1] ?? " ")
		) {
			let end = i + 1;
			while (end < sql.length && IDENTIFIER_CHAR.test(sql[end] ?? "")) end++;
			if (end > i + 1) {
				named.add(sql.slice(i + 1, end));
				i = end - 1;
			}
		}
	}
	return { anonymous, named: [...named] };
}

/** A value SQLite can store, or the error better-sqlite3 gave for one it cannot. */
function bindable(value: unknown): SQLInputValue {
	if (value === undefined || value === null) return null;
	switch (typeof value) {
		case "number":
		case "bigint":
		case "string":
			return value;
		default:
			if (value instanceof Uint8Array) return value;
			throw new TypeError("SQLite3 can only bind numbers, strings, bigints, buffers, and null");
	}
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** A row as a plain object, its BLOBs as Buffers over the same memory. */
function plainRow(row: Record<string, SQLOutputValue>): Record<string, unknown> {
	const plain: Record<string, unknown> = {};
	for (const column in row) {
		const value = row[column];
		plain[column] =
			value instanceof Uint8Array
				? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
				: value;
	}
	return plain;
}

/** SQLite's primary result codes, by number, as sqlite3.h names them. */
const PRIMARY_RESULT_CODES = (
	"OK ERROR INTERNAL PERM ABORT BUSY LOCKED NOMEM READONLY INTERRUPT IOERR CORRUPT NOTFOUND " +
	"FULL CANTOPEN PROTOCOL EMPTY SCHEMA TOOBIG CONSTRAINT MISMATCH MISUSE NOLFS AUTH FORMAT " +
	"RANGE NOTADB NOTICE WARNING"
).split(" ");

/**
 * SQLite's extended result codes, as sqlite3.h defines them: under a primary
 * code, the n-th name (from 1) is the code `primary | n << 8`, and `-` is a
 * number SQLite does not use.
 */
const EXTENDED_RESULT_CODES: Readonly<Record<string, string>> = {
	OK: "LOAD_PERMANENTLY SYMLINK",
	ERROR: "MISSING_COLLSEQ RETRY SNAPSHOT RESERVESIZE KEY UNABLE",
	ABORT: "- ROLLBACK",
	BUSY: "RECOVERY SNAPSHOT TIMEOUT",
	LOCKED: "SHAREDCACHE VTAB",
	READONLY: "RECOVERY CANTLOCK ROLLBACK DBMOVED CANTINIT DIRECTORY",
	IOERR:
		"READ SHORT_READ WRITE FSYNC DIR_FSYNC TRUNCATE FSTAT UNLOCK RDLOCK DELETE BLOCKED NOMEM " +
		"ACCESS CHECKRESERVEDLOCK LOCK CLOSE DIR_CLOSE SHMOPEN SHMSIZE SHMLOCK SHMMAP SEEK " +
		"DELETE_NOENT MMAP GETTEMPPATH CONVPATH VNODE AUTH BEGIN_ATOMIC COMMIT_ATOMIC " +
		"ROLLBACK_ATOMIC DATA CORRUPTFS IN_PAGE BADKEY CODEC",
	CORRUPT: "VTAB SEQUENCE INDEX",
	CANTOPEN: "NOTEMPDIR ISDIR FULLPATH CONVPATH DIRTYWAL SYMLINK",
	CONSTRAINT:
		"CHECK COMMITHOOK FOREIGNKEY FUNCTION NOTNULL PRIMARYKEY TRIGGER UNIQUE VTAB ROWID PINNED " +
		"DATATYPE",
	NOTICE: "RECOVER_WAL RECOVER_ROLLBACK RBU",
	WARNING: "AUTOINDEX",
	AUTH: "USER",
};

/**
 * The name of SQLite result code `errcode`, as better-sqlite3 put it in an
 * error's `code`. An extended code this table does not know is named by its
 * primary code.
 */
export function resultCodeName(errcode: number): string {
	const primary = PRIMARY_RESULT_CODES[errcode & 0xff];
	if (primary === undefined) return `SQLITE_UNKNOWN_${errcode}`;
	const extended = errcode >> 8;
	const suffix =
		extended > 0 ? EXTENDED_RESULT_CODES[primary]?.split(" ")[extended - 1] : undefined;
	return suffix !== undefined && suffix !== "-"
		? `SQLITE_${primary}_${suffix}`
		: `SQLITE_${primary}`;
}

/** An error `node:sqlite` threw for SQLite, given its result code's name in `code`. */
function sqliteError(error: unknown): unknown {
	if (error instanceof Error) {
		const sqlite = error as Error & { code?: unknown; errcode?: unknown };
		if (sqlite.code === "ERR_SQLITE_ERROR" && typeof sqlite.errcode === "number") {
			sqlite.code = resultCodeName(sqlite.errcode);
		}
	}
	return error;
}

interface BoundParameters {
	named: Record<string, SQLInputValue> | undefined;
	anonymous: SQLInputValue[];
}

export class Statement {
	private readonly shape: ParameterShape;

	constructor(
		private readonly inner: StatementSync,
		sql: string,
	) {
		this.shape = parameterShape(sql);
	}

	run(...params: unknown[]): RunResult {
		const { named: values, anonymous } = this.bind(params);
		try {
			const result =
				values === undefined ? this.inner.run(...anonymous) : this.inner.run(values, ...anonymous);
			return { changes: Number(result.changes) };
		} catch (error) {
			throw sqliteError(error);
		}
	}

	get(...params: unknown[]): unknown {
		const { named: values, anonymous } = this.bind(params);
		let row: Record<string, SQLOutputValue> | undefined;
		try {
			row =
				values === undefined ? this.inner.get(...anonymous) : this.inner.get(values, ...anonymous);
		} catch (error) {
			throw sqliteError(error);
		}
		return row === undefined ? undefined : plainRow(row);
	}

	all(...params: unknown[]): unknown[] {
		const { named: values, anonymous } = this.bind(params);
		let rows: Record<string, SQLOutputValue>[];
		try {
			rows =
				values === undefined ? this.inner.all(...anonymous) : this.inner.all(values, ...anonymous);
		} catch (error) {
			throw sqliteError(error);
		}
		return rows.map(plainRow);
	}

	/**
	 * The parameters as `node:sqlite` takes them, refused as better-sqlite3
	 * refused them: one plain object holds the named ones, every other argument
	 * is a `?` in order, and each parameter the SQL has must be given.
	 */
	private bind(params: readonly unknown[]): BoundParameters {
		let object: Readonly<Record<string, unknown>> | undefined;
		const anonymous: SQLInputValue[] = [];
		for (const param of params) {
			if (isPlainObject(param)) {
				if (object !== undefined) {
					throw new TypeError("You cannot specify named parameters in two different objects");
				}
				object = param;
			} else {
				anonymous.push(bindable(param));
			}
		}
		if (anonymous.length < this.shape.anonymous) {
			throw new RangeError("Too few parameter values were provided");
		}
		if (anonymous.length > this.shape.anonymous) {
			throw new RangeError("Too many parameter values were provided");
		}
		if (this.shape.named.length === 0) return { named: undefined, anonymous };
		const values: Record<string, SQLInputValue> = {};
		for (const name of this.shape.named) {
			if (object === undefined || !Object.hasOwn(object, name)) {
				throw new RangeError(`Missing named parameter "${name}"`);
			}
			values[name] = bindable(object[name]);
		}
		return { named: values, anonymous };
	}
}

export class Database {
	private readonly db: DatabaseSync;
	/** BEGIN, COMMIT, ROLLBACK and the savepoints, prepared once each. */
	private readonly controls = new Map<string, StatementSync>();
	private savepoints = 0;

	/**
	 * @param name a file, or `:memory:`
	 */
	constructor(
		readonly name: string,
		options: DatabaseOptions = {},
	) {
		try {
			this.db = new DatabaseSync(name, {
				readOnly: options.readonly === true,
				// better-sqlite3's: wait up to 5 s for a lock. db.ts sets it again,
				// with the rest of the hub's pragmas.
				timeout: 5000,
			});
		} catch (error) {
			throw sqliteError(error);
		}
	}

	/** Whether the connection is open: false once closed. */
	get open(): boolean {
		return this.db.isOpen;
	}

	prepare(sql: string): Statement {
		try {
			return new Statement(this.db.prepare(sql), sql);
		} catch (error) {
			throw sqliteError(error);
		}
	}

	/** Run `sql`, which may hold several statements, and no parameters. */
	exec(sql: string): void {
		try {
			this.db.exec(sql);
		} catch (error) {
			throw sqliteError(error);
		}
	}

	/**
	 * Run `PRAGMA <source>` and return its rows, or with `simple`, the first
	 * column of its first row.
	 */
	pragma(source: string, options: { simple?: boolean } = {}): unknown {
		let rows: Record<string, unknown>[];
		try {
			rows = this.db.prepare(`PRAGMA ${source}`).all().map(plainRow);
		} catch (error) {
			throw sqliteError(error);
		}
		if (options.simple !== true) return rows;
		const first = rows[0];
		return first === undefined ? undefined : Object.values(first)[0];
	}

	/**
	 * `fn` wrapped in a transaction: the function returned runs it between BEGIN
	 * and COMMIT, and rolls back if it throws. Called inside another, it runs in
	 * a savepoint of that one. `fn` must not return a promise: the transaction
	 * would end before it settles.
	 */
	transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
		return (...args: A): R => {
			if (this.db.isTransaction) return this.inSavepoint(fn, args);
			this.control("BEGIN");
			try {
				const result = fn(...args);
				if (isThenable(result)) {
					throw new TypeError("Transaction function cannot return a promise");
				}
				this.control("COMMIT");
				return result;
			} catch (error) {
				// SQLite may have rolled it back already, on some errors.
				if (this.db.isTransaction) this.control("ROLLBACK");
				throw error;
			}
		};
	}

	/** Close the connection; closing it again does nothing. */
	close(): void {
		if (!this.db.isOpen) return;
		this.controls.clear();
		this.db.close();
	}

	private inSavepoint<A extends unknown[], R>(fn: (...args: A) => R, args: A): R {
		const savepoint = `"lasterm.savepoint.${++this.savepoints}"`;
		try {
			this.control(`SAVEPOINT ${savepoint}`);
			try {
				const result = fn(...args);
				if (isThenable(result)) {
					throw new TypeError("Transaction function cannot return a promise");
				}
				this.control(`RELEASE ${savepoint}`);
				return result;
			} catch (error) {
				if (this.db.isTransaction) {
					this.control(`ROLLBACK TO ${savepoint}`);
					this.control(`RELEASE ${savepoint}`);
				}
				throw error;
			}
		} finally {
			this.savepoints--;
		}
	}

	private control(sql: string): void {
		try {
			let statement = this.controls.get(sql);
			if (statement === undefined) {
				statement = this.db.prepare(sql);
				this.controls.set(sql, statement);
			}
			statement.run();
		} catch (error) {
			throw sqliteError(error);
		}
	}
}

function isThenable(value: unknown): boolean {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}
