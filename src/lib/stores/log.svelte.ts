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

export function getLogEntries(): LogEntry[] {
	// Reading version subscribes the caller to updates
	void version;
	return _entries;
}

export function getLogVersion(): number {
	return version;
}

export function log(level: LogLevel, message: string) {
	_entries.push({ id: nextId++, timestamp: new Date(), level, message });
	if (_entries.length > MAX_ENTRIES) {
		_entries.splice(0, _entries.length - MAX_ENTRIES);
	}
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
