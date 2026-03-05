export type Theme = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'nextui-dashboard-theme';

let theme: Theme = $state(loadTheme());

function loadTheme(): Theme {
	if (typeof localStorage === 'undefined') return 'system';
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
	return 'system';
}

let systemPrefersDark: boolean = $state(
	typeof window !== 'undefined'
		? window.matchMedia('(prefers-color-scheme: dark)').matches
		: true
);

function resolveTheme(t: Theme): 'dark' | 'light' {
	if (t === 'system') return systemPrefersDark ? 'dark' : 'light';
	return t;
}

function applyTheme(t: Theme) {
	if (typeof document === 'undefined') return;
	const resolved = resolveTheme(t);
	document.documentElement.classList.toggle('light', resolved === 'light');
}

// Listen for OS theme changes — re-apply when in system mode
if (typeof window !== 'undefined') {
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
		systemPrefersDark = e.matches;
		if (theme === 'system') applyTheme(theme);
	});
}

// Apply on load
applyTheme(theme);

export function getTheme(): Theme {
	return theme;
}

export function toggleTheme() {
	theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
	if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, theme);
	applyTheme(theme);
}

export function isDark(): boolean {
	return resolveTheme(theme) === 'dark';
}
