/**
 * Parsing, rendering and Palette Studio link generation for NextUI color
 * palette files.
 *
 * NextUI palettes are plain-text files placed under `<SDCARD>/Palettes/*.txt`
 * that appear under Settings > Appearance > Color Palette. Format:
 *
 *   version=1
 *   name=Example
 *   color1=0xffffffff
 *   ...
 *   color7=0x0b0e0cff
 *
 * See the upstream README:
 * https://github.com/LoveRetro/NextUI/blob/main/skeleton/BASE/Palettes/README.txt
 */

/** Number of color slots in a NextUI palette (color1..color7). */
export const COLOR_COUNT = 7;

/** Human-readable purpose of each color slot, in order (color1..color7). */
export const SLOT_LABELS: readonly string[] = [
	'Main UI elements',
	'Primary accent highlights',
	'Secondary accent',
	'List text',
	'Selected list text',
	'Hint / info text',
	'Background'
];

export interface Palette {
	/** Palette format version, or null if the file omits it. */
	version: number | null;
	/** The `name=` label, or null if omitted (menu falls back to the filename). */
	name: string | null;
	/**
	 * color1..color7 as normalized uppercase hex WITHOUT the `0x` prefix,
	 * either 6 (RRGGBB) or 8 (RRGGBBAA) digits. `null` for any slot the file
	 * leaves unset (NextUI falls back to its default for that slot).
	 */
	colors: (string | null)[];
	/** The original, unmodified file text. */
	raw: string;
}

/** Base URL of the community "NextUI Palette Studio" web editor. */
export const STUDIO_BASE = 'https://leaf.game/nextui-palettes/';

/**
 * Normalize a palette color value into uppercase hex without the `0x` prefix.
 * Accepts `0xRRGGBB`, `0xRRGGBBAA`, or the same without the prefix.
 * Returns null if the value is not a valid 6- or 8-digit hex color.
 */
function normalizeHex(value: string): string | null {
	let v = value.trim();
	if (v.startsWith('0x') || v.startsWith('0X')) v = v.slice(2);
	if (!/^[0-9a-fA-F]+$/.test(v)) return null;
	if (v.length !== 6 && v.length !== 8) return null;
	return v.toUpperCase();
}

/** Parse a palette file's text into a structured {@link Palette}. */
export function parsePalette(text: string): Palette {
	const colors: (string | null)[] = new Array(COLOR_COUNT).fill(null);
	let version: number | null = null;
	let name: string | null = null;

	for (const rawLine of text.split('\n')) {
		const line = rawLine.replace(/\r$/, '').trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim().toLowerCase();
		const val = line.slice(eq + 1).trim();

		if (key === 'version') {
			const n = parseInt(val, 10);
			version = Number.isNaN(n) ? null : n;
		} else if (key === 'name') {
			name = val;
		} else {
			const m = key.match(/^color([1-7])$/);
			if (m) colors[parseInt(m[1], 10) - 1] = normalizeHex(val);
		}
	}

	return { version, name, colors, raw: text };
}

/**
 * The label shown for a palette: its `name=` field, or the filename with the
 * `.txt` extension stripped and underscores turned into spaces (matching how
 * NextUI derives the menu label when `name=` is omitted).
 */
export function paletteDisplayName(palette: Palette, filename: string): string {
	if (palette.name) return palette.name;
	return filename.replace(/\.txt$/i, '').replace(/_/g, ' ');
}

/** A CSS color for a normalized hex value (6 or 8 digits), or null. */
export function cssColor(hex: string | null): string | null {
	return hex ? `#${hex}` : null;
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build a "NextUI Palette Studio" link that opens the editor pre-loaded with
 * the given palette's colors, encoded the way the studio itself does.
 *
 * The `?t=` payload is base64url (no padding) of:
 *   - if every color is fully opaque: the 7 RGB triplets — 21 bytes.
 *   - otherwise: a 1-byte alpha bitmask (bit i ⇒ colorN, N = i + 1, has a
 *     non-opaque alpha), then the 21 RGB bytes, then one alpha byte per set
 *     bit in ascending color order.
 *
 * Alpha comes from 8-digit (RRGGBBAA) slots; 6-digit and unset slots are
 * treated as fully opaque (0xFF). Unset slots encode RGB as black.
 */
export function studioUrl(colors: (string | null)[]): string {
	const rgb = new Uint8Array(COLOR_COUNT * 3);
	let alphaMask = 0;
	const alphas: number[] = [];

	for (let i = 0; i < COLOR_COUNT; i++) {
		const hex = colors[i];
		for (let j = 0; j < 3; j++) {
			rgb[i * 3 + j] = hex ? parseInt(hex.slice(j * 2, j * 2 + 2), 16) : 0;
		}
		const alpha = hex && hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 0xff;
		if (alpha !== 0xff) {
			alphaMask |= 1 << i;
			alphas.push(alpha);
		}
	}

	let bytes: Uint8Array;
	if (alphaMask === 0) {
		bytes = rgb;
	} else {
		bytes = new Uint8Array(1 + rgb.length + alphas.length);
		bytes[0] = alphaMask;
		bytes.set(rgb, 1);
		bytes.set(alphas, 1 + rgb.length);
	}
	return `${STUDIO_BASE}?t=${toBase64Url(bytes)}`;
}
