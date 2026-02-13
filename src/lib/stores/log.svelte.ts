export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
	id: number;
	timestamp: Date;
	level: LogLevel;
	message: string;
}

const MAX_ENTRIES = 500;

// Use a plain array + a version counter to avoid deep reactivity on every entry object
const _entries: LogEntry[] = [];
let version: number = $state(0);
let nextId = 0;

/** Returns a snapshot of current log entries. Reading this subscribes the caller to updates. */
export function getLogEntries(): LogEntry[] {
	void version;
	return _entries.slice();
}

export function log(level: LogLevel, message: string) {
	if (_entries.length >= MAX_ENTRIES) {
		// Drop oldest half in one operation instead of splicing one-by-one
		_entries.splice(0, MAX_ENTRIES >> 1);
	}
	_entries.push({ id: nextId++, timestamp: new Date(), level, message });
	version++;
}

export function clearLog() {
	_entries.length = 0;
	version++;
}

// Convenience helpers
export const adbLog = {
	info: (msg: string) => log('info', msg),
	warn: (msg: string) => log('warn', msg),
	error: (msg: string) => log('error', msg),
	debug: (msg: string) => log('debug', msg)
};
