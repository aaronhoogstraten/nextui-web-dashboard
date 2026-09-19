/**
 * Escape a string for safe use as a shell argument in POSIX sh.
 * Wraps the value in single quotes, escaping any embedded single quotes.
 */
function shellEscape(arg: string): string {
	return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Type-safe shell command builder. Commands can only be constructed via
 * static factory methods, which handle argument escaping internally.
 * This makes shell injection impossible by construction.
 *
 * Usage: `await adbExec(ShellCmd.mkdir(path))`
 */
export class ShellCmd {
	private readonly _command: string;
	private constructor(command: string) {
		this._command = command;
	}

	/** Create a directory (and parents). */
	static mkdir(path: string): ShellCmd {
		return new ShellCmd(`mkdir -p ${shellEscape(path)}`);
	}

	/**
	 * Move or rename a path, clobbering an existing destination, so callers must
	 * check the target themselves first. `-f` is not optional: without it BusyBox
	 * prompts on stdin when the destination is not writable, and the raw shell
	 * socket gives it a tty nothing on this side can ever answer.
	 *
	 * `-f` is the only flag safe to use here: tg5040 ships BusyBox 1.27.2, the
	 * oldest build we support, whose `mv` is `[-fin]` — no `-T` and no `-t`,
	 * both of which h700's 1.36.1 does have.
	 */
	static mv(from: string, to: string): ShellCmd {
		return new ShellCmd(`mv -f ${shellEscape(from)} ${shellEscape(to)}`);
	}

	/** Remove a file. */
	static rm(path: string): ShellCmd {
		return new ShellCmd(`rm ${shellEscape(path)}`);
	}

	/** Remove a file, ignoring errors if it doesn't exist. */
	static rmf(path: string): ShellCmd {
		return new ShellCmd(`rm -f ${shellEscape(path)}`);
	}

	/**
	 * Remove several files in one call, ignoring errors if they don't exist.
	 * An empty list builds a no-op — `rm -f` with no operands is an error on BusyBox.
	 */
	static rmMany(paths: string[]): ShellCmd {
		if (paths.length === 0) return new ShellCmd('true');
		return new ShellCmd(`rm -f ${paths.map(shellEscape).join(' ')}`);
	}

	/** Remove a directory and all its contents recursively. */
	static rmrf(path: string): ShellCmd {
		return new ShellCmd(`rm -rf ${shellEscape(path)}`);
	}

	/** Find files/dirs by name pattern (case-insensitive). */
	static find(basePath: string, namePattern: string): ShellCmd {
		return new ShellCmd(
			`find ${shellEscape(basePath)} -iname ${shellEscape(namePattern)} -maxdepth 8 2>/dev/null`
		);
	}

	/** Get filesystem disk usage info. */
	static df(path: string): ShellCmd {
		return new ShellCmd(`df ${shellEscape(path)}`);
	}

	/** Tail a file with follow, showing the last N lines. */
	static tailFollow(path: string, lines = 200): ShellCmd {
		return new ShellCmd(`tail -n ${lines} -f ${shellEscape(path)}`);
	}

	toString(): string {
		return this._command;
	}
}
