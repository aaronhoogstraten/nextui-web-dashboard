export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'nextui-dashboard-theme';

let theme: Theme = $state(loadTheme());

function loadTheme(): Theme {
	if (typeof localStorage === 'undefined') return 'dark';
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === 'light' || stored === 'dark') return stored;
	return 'dark';
}

function applyTheme(t: Theme) {
	if (typeof document === 'undefined') return;
	document.documentElement.classList.toggle('light', t === 'light');
}

// Apply on load — intentionally reads the initial value (toggleTheme re-applies on change)
applyTheme(loadTheme());

export function getTheme(): Theme {
	return theme;
}

export function toggleTheme() {
	theme = theme === 'dark' ? 'light' : 'dark';
	if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, theme);
	applyTheme(theme);
}

export function isDark(): boolean {
	return theme === 'dark';
}
