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

	/** Remove a file. */
	static rm(path: string): ShellCmd {
		return new ShellCmd(`rm ${shellEscape(path)}`);
	}

	/** Remove a file, ignoring errors if it doesn't exist. */
	static rmf(path: string): ShellCmd {
		return new ShellCmd(`rm -f ${shellEscape(path)}`);
	}

	/** Remove a directory and all its contents recursively. */
	static rmrf(path: string): ShellCmd {
		return new ShellCmd(`rm -rf ${shellEscape(path)}`);
	}

	/** Find files/dirs by name pattern (case-insensitive). */
	static find(basePath: string, namePattern: string): ShellCmd {
		return new ShellCmd(`find ${shellEscape(basePath)} -iname ${shellEscape(namePattern)} -maxdepth 8 2>/dev/null`);
	}

	/** Get filesystem disk usage info. */
	static df(path: string): ShellCmd {
		return new ShellCmd(`df ${shellEscape(path)}`);
	}

	toString(): string {
		return this._command;
	}
}
