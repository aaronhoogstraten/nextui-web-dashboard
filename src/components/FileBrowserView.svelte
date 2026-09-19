<script lang="ts" module>
	const TEXT_EXTENSIONS = new Set([
		'.txt',
		'.cfg',
		'.conf',
		'.ini',
		'.json',
		'.sh',
		'.xml',
		'.yml',
		'.log',
		'.csv',
		'.m3u',
		'.cue'
	]);
	const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.svg']);

	// A folder download is assembled entirely in browser memory — every file is
	// held as a Uint8Array while the zip is built, so peak usage is roughly twice
	// the folder size. Past these thresholds we warn before starting.
	const LARGE_DOWNLOAD_BYTES = 512 * 1024 * 1024;
	const LARGE_DOWNLOAD_FILES = 1000;

	// Browser-based transfer over USB is slow and fragile compared to pulling the
	// card. Anyone hitting the thresholds above should hear that before waiting.
	const BULK_TRANSFER_ADVICE =
		'For large transfers, it is recommended to use an SD card reader instead of the Dashboard.';
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import {
		listDirectory,
		pullFile,
		pushFile,
		isDirectory,
		pathExists,
		searchFiles,
		walkDirectory,
		type WalkResult,
		type WalkLimit
	} from '$lib/adb/file-ops.js';
	import {
		beginTransfer,
		endTransfer,
		trackedPush,
		trackedPull,
		skipTransferFile
	} from '$lib/stores/transfer.svelte.js';
	import { DEVICE_PATHS, type DirectoryEntry } from '$lib/adb/types.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import {
		formatSize,
		formatError,
		compareByName,
		getMimeType,
		joinPath,
		pickFiles,
		pickDirectory,
		plural,
		errorMsg,
		successMsg,
		type Notification
	} from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import ActionButton from './ActionButton.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import ImagePreview from './ImagePreview.svelte';
	import StatusMessage from './StatusMessage.svelte';
	import JSZip from 'jszip';

	let { adb }: { adb: Adb } = $props();

	let confirmDialog: ConfirmDialog;

	let currentPath: string = $state(DEVICE_PATHS.base);
	let entries: DirectoryEntry[] = $state([]);
	let loading = $state(false);
	let notice: Notification | null = $state(null);
	let sortKey: 'name' | 'size' | 'mtime' = $state('name');
	let sortAsc = $state(true);
	let uploading = $state(false);
	let downloadingFile: string | null = $state(null);
	let downloadingFolder: string | null = $state(null);
	let folderProgress: string = $state('');
	let deletingEntry: string | null = $state(null);
	let renamingEntry: string | null = $state(null);
	let searchQuery = $state('');
	let searchResults: string[] | null = $state(null);
	let searching = $state(false);
	let dragOver = $state(false);
	let dragCounter = $state(0);

	const pathSegments = $derived(getPathSegments(currentPath));
	const sortedEntries = $derived(getSortedEntries(entries, sortKey, sortAsc));

	function getPathSegments(path: string): { name: string; path: string }[] {
		const parts = path.split('/').filter(Boolean);
		const segments: { name: string; path: string }[] = [{ name: '/', path: '/' }];
		let accumulated = '';
		for (const part of parts) {
			accumulated += '/' + part;
			segments.push({ name: part, path: accumulated });
		}
		return segments;
	}

	function getSortedEntries(
		items: DirectoryEntry[],
		key: 'name' | 'size' | 'mtime',
		asc: boolean
	): DirectoryEntry[] {
		const sorted = [...items].sort((a, b) => {
			// Directories always first
			if (a.isDirectory && !b.isDirectory) return -1;
			if (!a.isDirectory && b.isDirectory) return 1;

			let cmp = 0;
			if (key === 'name') {
				cmp = compareByName(a, b);
			} else if (key === 'size') {
				cmp = Number(a.size - b.size);
			} else {
				cmp = Number(a.mtime - b.mtime);
			}
			return asc ? cmp : -cmp;
		});
		return sorted;
	}

	function toggleSort(key: 'name' | 'size' | 'mtime') {
		if (sortKey === key) {
			sortAsc = !sortAsc;
		} else {
			sortKey = key;
			sortAsc = true;
		}
	}

	function sortIndicator(key: 'name' | 'size' | 'mtime'): string {
		if (sortKey !== key) return '';
		return sortAsc ? ' \u25B2' : ' \u25BC';
	}

	async function navigate(path: string, skipDirtyCheck = false) {
		if (!skipDirtyCheck && editorDirty) {
			if (!confirm('Discard unsaved changes?')) return;
		}
		if (editorPath && !skipDirtyCheck) {
			editorPath = null;
			editorContent = '';
			editorOriginal = '';
			editorError = '';
		}
		loading = true;
		notice = null;
		try {
			const result = await listDirectory(adb, path);
			entries = result;
			currentPath = path;
		} catch (e) {
			notice = errorMsg(`Failed to list ${path}: ${formatError(e)}`);
		}
		loading = false;
	}

	async function handleEntryClick(entry: DirectoryEntry) {
		if (entry.isDirectory) {
			await navigate(joinPath(currentPath, entry.name));
		}
	}

	function navigateUp() {
		if (currentPath === '/') return;
		const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
		navigate(parent);
	}

	async function downloadFile(entry: DirectoryEntry) {
		if (entry.isDirectory) return;
		downloadingFile = entry.name;
		beginTransfer('download', 1);
		try {
			const remotePath = joinPath(currentPath, entry.name);
			const content = await trackedPull(adb, remotePath);

			// Trigger browser download
			const blob = new Blob([content]);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = entry.name;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			notice = errorMsg(`Download failed: ${formatError(e)}`);
		} finally {
			endTransfer();
		}
		downloadingFile = null;
	}

	/**
	 * The scan caps are soft — hitting one asks whether to keep going rather than
	 * silently handing back a partial tree. Returns true to lift the cap;
	 * declining abandons the download rather than zipping a partial folder.
	 */
	function confirmWalkLimit(name: string, limit: WalkLimit): Promise<boolean> {
		return confirmDialog.show({
			title: 'Unusually large folder',
			summary:
				limit.kind === 'files'
					? `"${name}" holds more than ${limit.limit.toLocaleString()} files.`
					: `"${name}" is nested more than ${limit.limit} folders deep.`,
			advice: BULK_TRANSFER_ADVICE,
			details: [
				'Scanning the rest will take longer, and the download that follows will be correspondingly larger.'
			],
			confirmLabel: 'Keep scanning',
			cancelLabel: 'Cancel download',
			confirmVariant: 'warning'
		});
	}

	/**
	 * Warn before a download big enough to stall the tab or exhaust memory.
	 * Returns false if the user backs out.
	 */
	async function confirmFolderDownload(name: string, walk: WalkResult): Promise<boolean> {
		const heavy =
			walk.totalBytes >= LARGE_DOWNLOAD_BYTES || walk.files.length >= LARGE_DOWNLOAD_FILES;
		if (!heavy && walk.skipped.length === 0) return true;

		const details: string[] = [];
		if (heavy) {
			details.push(
				'If you continue here, the whole folder is held in browser memory while the zip is built, so this can take several minutes and may run out of memory. Downloading subfolders one at a time is safer.'
			);
		}
		if (walk.skipped.length > 0) {
			details.push(
				`${plural(walk.skipped.length, 'folder')} could not be read and will be omitted.`
			);
		}

		return confirmDialog.show({
			title: `Download "${name}"?`,
			summary: `${plural(walk.files.length, 'file')} totalling ${formatSize(walk.totalBytes)}.`,
			advice: heavy ? BULK_TRANSFER_ADVICE : undefined,
			details,
			confirmLabel: 'Download anyway',
			confirmVariant: heavy ? 'warning' : 'primary'
		});
	}

	async function downloadFolder(entry: DirectoryEntry) {
		if (!entry.isDirectory) return;
		const rootPath = joinPath(currentPath, entry.name);

		downloadingFolder = entry.name;
		notice = null;
		folderProgress = `Scanning ${entry.name}...`;

		try {
			const walk = await walkDirectory(adb, rootPath, {
				onProgress: (found) => {
					folderProgress = `Scanning ${entry.name}... ${plural(found, 'file')} found`;
				},
				onLimit: (limit) => confirmWalkLimit(entry.name, limit)
			});

			// Backing out of any prompt abandons the download outright — a partial
			// zip that looks like the real folder is worse than no zip at all
			if (walk.aborted) {
				notice = errorMsg(`Download of "${entry.name}" cancelled.`);
				return;
			}
			if (walk.files.length === 0) {
				notice = errorMsg(`"${entry.name}" contains no files to download.`);
				return;
			}
			if (!(await confirmFolderDownload(entry.name, walk))) {
				notice = errorMsg(`Download of "${entry.name}" cancelled.`);
				return;
			}

			const zip = new JSZip();
			let completed = 0;
			const failed: string[] = [];
			beginTransfer('download', walk.files.length, walk.totalBytes);

			for (const file of walk.files) {
				folderProgress = `Downloading ${completed + 1}/${walk.files.length}: ${file.relativePath}`;
				try {
					const data = await trackedPull(adb, file.path);
					// Nest under the folder name so extracting yields one tidy directory.
					// Carry the device mtime across; JSZip otherwise stamps "now".
					zip.file(`${entry.name}/${file.relativePath}`, data, {
						date: file.mtime > 0n ? new Date(Number(file.mtime) * 1000) : undefined
					});
				} catch {
					// One unreadable file shouldn't discard an otherwise complete download.
					// pullFile already logged the underlying error.
					failed.push(file.relativePath);
					skipTransferFile(Number(file.size));
				}
				completed++;
			}

			folderProgress = 'Creating zip...';
			const blob = await zip.generateAsync(
				// Level 1: ROMs and images are already compressed, so heavier settings
				// cost minutes of CPU for almost no size win
				{ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } },
				(meta) => {
					folderProgress = `Creating zip... ${meta.percent.toFixed(0)}%`;
				}
			);

			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${entry.name}.zip`;
			a.click();
			URL.revokeObjectURL(url);

			const downloaded = walk.files.length - failed.length;
			const problems = [
				...(failed.length > 0 ? [`${plural(failed.length, 'file')} unreadable`] : []),
				...(walk.skipped.length > 0
					? [`${plural(walk.skipped.length, 'folder')} could not be read`]
					: [])
			];
			const summary = `Downloaded ${entry.name}.zip (${plural(downloaded, 'file')}, ${formatSize(blob.size)})`;
			notice =
				problems.length > 0 ? errorMsg(`${summary} — ${problems.join(', ')}`) : successMsg(summary);
		} catch (e) {
			notice = errorMsg(`Folder download failed: ${formatError(e)}`);
		} finally {
			endTransfer();
			folderProgress = '';
			downloadingFolder = null;
		}
	}

	async function uploadFiles() {
		const files = await pickFiles();
		if (files.length === 0) return;

		uploading = true;
		notice = null;
		let uploaded = 0;
		const totalBytes = Array.from(files).reduce((sum, f) => sum + f.size, 0);
		beginTransfer('upload', files.length, totalBytes);

		try {
			for (const file of files) {
				const data = new Uint8Array(await file.arrayBuffer());
				await trackedPush(adb, joinPath(currentPath, file.name), data);
				uploaded++;
			}
			await navigate(currentPath);
			// navigate() clears `notice`, and sets one of its own if the listing
			// failed, so the success message goes after it and defers to that error.
			if (!notice) notice = successMsg(`Uploaded ${uploaded} file(s)`);
		} catch (e) {
			notice = errorMsg(`Upload failed: ${formatError(e)}`);
		} finally {
			endTransfer();
		}
		uploading = false;
	}

	let creatingFolder = $state(false);

	async function createFolder() {
		const name = prompt('New folder name:');
		if (!name || !name.trim()) return;
		const trimmed = name.trim();
		if (trimmed.includes('/') || trimmed.includes('\\')) {
			notice = errorMsg('Folder name cannot contain slashes');
			return;
		}
		creatingFolder = true;
		notice = null;
		try {
			const remotePath = joinPath(currentPath, trimmed);
			await adbExec(ShellCmd.mkdir(remotePath));
			await navigate(currentPath);
		} catch (e) {
			notice = errorMsg(`Failed to create folder: ${formatError(e)}`);
		}
		creatingFolder = false;
	}

	/**
	 * Run a `mv`, surfacing failure as an exception. The raw shell socket carries
	 * no exit status, so a failed move (read-only card, name rejected by FAT)
	 * only shows up as text on stderr.
	 */
	async function movePath(from: string, to: string) {
		const output = (await adbExec(ShellCmd.mv(from, to))).trim();
		if (output) throw new Error(output);
	}

	/**
	 * Rename through a temporary name, for a change of case only. The card is
	 * vfat — case-insensitive, case-preserving — where `mv -f Readme.txt
	 * readme.txt` does nothing at all: it exits 0 and prints no error, so
	 * movePath cannot tell it from a success and we would report a rename that
	 * never happened. The destination check is no use either, since it matches
	 * the source itself. Two hops sidestep both, and are harmless on a
	 * case-sensitive filesystem. Measured on BusyBox v1.36.1 / h700.
	 */
	async function renameViaTemp(fromPath: string, toPath: string, newName: string) {
		const tempPath = joinPath(currentPath, `.rename-${Math.random().toString(36).slice(2, 10)}`);
		await movePath(fromPath, tempPath);
		try {
			// With the source moved aside, anything still at the destination is a
			// genuinely different file on a case-sensitive filesystem. Never clobber it.
			if (await pathExists(adb, toPath)) {
				throw new Error(`"${newName}" already exists here`);
			}
			await movePath(tempPath, toPath);
		} catch (e) {
			// Put the original name back rather than stranding the item under a
			// temporary name the user never chose and would not recognise.
			try {
				await movePath(tempPath, fromPath);
			} catch {
				throw new Error(`${formatError(e)} — could not undo, the item is now named ${tempPath}`);
			}
			throw e;
		}
	}

	async function renameEntry(entry: DirectoryEntry) {
		const kind = entry.isDirectory ? 'folder' : 'file';
		const input = prompt(`Rename ${kind} "${entry.name}" to:`, entry.name);
		if (input === null) return;
		const newName = input.trim();
		if (!newName || newName === entry.name) return;
		if (newName.includes('/') || newName.includes('\\')) {
			notice = errorMsg('Name cannot contain slashes');
			return;
		}
		if (newName === '.' || newName === '..') {
			notice = errorMsg(`"${newName}" is not a valid name`);
			return;
		}

		const fromPath = joinPath(currentPath, entry.name);
		const toPath = joinPath(currentPath, newName);
		// A change of case alone needs the two-hop path below; vfat silently
		// ignores a direct mv between two spellings of one name.
		const caseOnly = newName.toLowerCase() === entry.name.toLowerCase();
		renamingEntry = entry.name;
		notice = null;
		let replacedOpenEditor = false;
		try {
			if (caseOnly) {
				await renameViaTemp(fromPath, toPath, newName);
			} else {
				if (await pathExists(adb, toPath)) {
					const targetKind = (await isDirectory(adb, toPath)) ? 'folder' : 'file';
					// `mv` onto an existing directory moves the source *into* it rather
					// than replacing it, and it will not put a folder over a file.
					// Replacing a whole folder is too destructive to offer either way,
					// so only file-over-file gets the overwrite prompt below.
					if (targetKind === 'folder' || entry.isDirectory) {
						notice = errorMsg(`A ${targetKind} named "${newName}" already exists here`);
						return;
					}
					const overwrite = await confirmDialog.show({
						title: `Replace "${newName}"?`,
						summary: `A file named "${newName}" already exists in this folder.`,
						details: ['Renaming will overwrite it. This cannot be undone.'],
						confirmLabel: 'Replace',
						confirmVariant: 'danger'
					});
					if (!overwrite) return;
				}
				await movePath(fromPath, toPath);
			}

			// Keep an open editor pointed at the file it is actually editing — the
			// file itself, or one nested under a renamed folder. Otherwise saving
			// would recreate the old path.
			if (editorPath === fromPath) {
				editorPath = toPath;
			} else if (editorPath?.startsWith(fromPath + '/')) {
				editorPath = toPath + editorPath.slice(fromPath.length);
			} else if (editorPath === toPath) {
				// The editor's file was just overwritten by the rename. Its buffer is
				// now a copy of something deleted, and saving would undo the rename,
				// so drop it rather than let that happen silently.
				editorPath = null;
				editorContent = '';
				editorOriginal = '';
				editorError = '';
				replacedOpenEditor = true;
			}

			await navigate(currentPath, true);
			// navigate() clears `notice`, and sets one of its own if the listing
			// failed — reporting success over that would hide a stale table.
			if (!notice) {
				notice = successMsg(
					`Renamed to "${newName}"` +
						(replacedOpenEditor ? ' — closed the editor, its file was replaced' : '')
				);
			}
		} catch (e) {
			notice = errorMsg(`Failed to rename: ${formatError(e)}`);
		} finally {
			renamingEntry = null;
		}
	}

	async function deleteEntry(entry: DirectoryEntry) {
		const kind = entry.isDirectory ? 'folder' : 'file';
		if (
			!confirm(
				`Delete ${kind} "${entry.name}"?${entry.isDirectory ? ' This will remove all contents.' : ''}`
			)
		)
			return;
		deletingEntry = entry.name;
		notice = null;
		try {
			const remotePath = joinPath(currentPath, entry.name);
			if (entry.isDirectory) {
				await adbExec(ShellCmd.rmrf(remotePath));
			} else {
				await adbExec(ShellCmd.rmf(remotePath));
			}
			await navigate(currentPath);
		} catch (e) {
			notice = errorMsg(`Failed to delete: ${formatError(e)}`);
		}
		deletingEntry = null;
	}

	async function uploadFolder() {
		const files = await pickDirectory();
		if (files.length === 0) return;

		uploading = true;
		notice = null;
		let uploaded = 0;
		const createdDirs = new Set<string>();
		const totalBytes = Array.from(files).reduce((sum, f) => sum + f.size, 0);
		beginTransfer('upload', files.length, totalBytes);

		try {
			for (const file of files) {
				// webkitRelativePath is e.g. "FolderName/sub/file.txt"
				const relativePath = file.webkitRelativePath;
				const lastSlash = relativePath.lastIndexOf('/');
				if (lastSlash > 0) {
					const dirPath = joinPath(currentPath, relativePath.substring(0, lastSlash));
					if (!createdDirs.has(dirPath)) {
						await adbExec(ShellCmd.mkdir(dirPath));
						createdDirs.add(dirPath);
					}
				}

				const data = new Uint8Array(await file.arrayBuffer());
				await trackedPush(adb, joinPath(currentPath, relativePath), data);
				uploaded++;
			}
			await navigate(currentPath);
			if (!notice) notice = successMsg(`Uploaded ${plural(uploaded, 'file')}`);
		} catch (e) {
			notice = errorMsg(`Upload failed after ${uploaded} files: ${formatError(e)}`);
		} finally {
			endTransfer();
		}
		uploading = false;
	}

	async function doSearch() {
		const q = searchQuery.trim();
		if (!q) return;
		searching = true;
		notice = null;
		try {
			searchResults = await searchFiles(adb, currentPath, q);
			if (searchResults.length === 0) {
				notice = errorMsg(`No results for "${q}"`);
			}
		} catch (e) {
			notice = errorMsg(`Search failed: ${formatError(e)}`);
		}
		searching = false;
	}

	function clearSearch() {
		searchResults = null;
		searchQuery = '';
	}

	async function navigateToResult(fullPath: string) {
		clearSearch();
		if (await isDirectory(adb, fullPath)) {
			navigate(fullPath);
		} else {
			const lastSlash = fullPath.lastIndexOf('/');
			const parentDir = lastSlash > 0 ? fullPath.substring(0, lastSlash) : '/';
			navigate(parentDir);
		}
	}

	function formatDate(mtime: bigint): string {
		const ms = Number(mtime) * 1000;
		if (ms === 0) return '\u2014';
		return new Date(ms).toLocaleString();
	}

	// --- Text Editor ---

	function isTextFile(name: string): boolean {
		const dot = name.lastIndexOf('.');
		if (dot < 0) return false;
		return TEXT_EXTENSIONS.has(name.substring(dot).toLowerCase());
	}

	let editorPath: string | null = $state(null);
	let editorContent: string = $state('');
	let editorOriginal: string = $state('');
	let editorLoading = $state(false);
	let editorSaving = $state(false);
	let editorError: string = $state('');

	let editorDirty = $derived(editorContent !== editorOriginal);

	function editorFileName(): string {
		if (!editorPath) return '';
		return editorPath.substring(editorPath.lastIndexOf('/') + 1);
	}

	async function openEditor(remotePath: string) {
		if (editorDirty && !confirm('Discard unsaved changes?')) return;
		editorPath = remotePath;
		editorLoading = true;
		editorError = '';
		try {
			const data = await pullFile(adb, remotePath);
			const text = new TextDecoder().decode(data);
			editorContent = text;
			editorOriginal = text;
		} catch (e) {
			editorError = `Failed to open: ${formatError(e)}`;
		} finally {
			editorLoading = false;
		}
	}

	async function saveEditor() {
		if (!editorPath) return;
		editorSaving = true;
		editorError = '';
		try {
			const data = new TextEncoder().encode(editorContent);
			await pushFile(adb, editorPath, data);
			editorOriginal = editorContent;
			editorError = 'Saved';
		} catch (e) {
			editorError = `Save failed: ${formatError(e)}`;
		} finally {
			editorSaving = false;
		}
	}

	function closeEditor() {
		if (editorDirty && !confirm('Discard unsaved changes?')) return;
		editorPath = null;
		editorContent = '';
		editorOriginal = '';
		editorError = '';
	}

	// --- Image Preview ---

	function isImageFile(name: string): boolean {
		const dot = name.lastIndexOf('.');
		if (dot < 0) return false;
		return IMAGE_EXTENSIONS.has(name.substring(dot).toLowerCase());
	}

	let previewSrc: string | null = $state(null);
	let previewAlt: string = $state('');
	let previewLoading: string | null = $state(null);

	async function previewImage(entry: DirectoryEntry) {
		previewLoading = entry.name;
		try {
			const remotePath = joinPath(currentPath, entry.name);
			const data = await pullFile(adb, remotePath);
			const blob = new Blob([data], { type: getMimeType(entry.name) });
			if (previewSrc) URL.revokeObjectURL(previewSrc);
			previewSrc = URL.createObjectURL(blob);
			previewAlt = entry.name;
		} catch (e) {
			notice = errorMsg(`Preview failed: ${formatError(e)}`);
		} finally {
			previewLoading = null;
		}
	}

	function closePreview() {
		if (previewSrc) URL.revokeObjectURL(previewSrc);
		previewSrc = null;
		previewAlt = '';
	}

	// --- Drag-and-Drop Upload ---

	function readAllEntries(
		entry: FileSystemEntry,
		basePath = ''
	): Promise<{ file: File; relativePath: string }[]> {
		if (entry.isFile) {
			return new Promise((resolve, reject) => {
				(entry as FileSystemFileEntry).file(
					(f) => resolve([{ file: f, relativePath: basePath + f.name }]),
					reject
				);
			});
		}
		const reader = (entry as FileSystemDirectoryEntry).createReader();
		return new Promise((resolve, reject) => {
			const allEntries: FileSystemEntry[] = [];
			const readBatch = () => {
				reader.readEntries((batch) => {
					if (batch.length === 0) {
						Promise.all(allEntries.map((e) => readAllEntries(e, basePath + entry.name + '/'))).then(
							(results) => resolve(results.flat()),
							reject
						);
					} else {
						allEntries.push(...batch);
						readBatch();
					}
				}, reject);
			};
			readBatch();
		});
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragCounter = 0;
		dragOver = false;
		if (!e.dataTransfer?.items || uploading) return;

		const items = Array.from(e.dataTransfer.items).filter((i) => i.kind === 'file');
		const fsEntries = items
			.map((i) => i.webkitGetAsEntry())
			.filter((entry): entry is FileSystemEntry => entry !== null);
		if (fsEntries.length === 0) return;

		const allFiles = (await Promise.all(fsEntries.map((entry) => readAllEntries(entry)))).flat();
		if (allFiles.length === 0) return;

		uploading = true;
		notice = null;
		let uploaded = 0;
		const totalBytes = allFiles.reduce((sum, { file }) => sum + file.size, 0);
		const createdDirs = new Set<string>();
		beginTransfer('upload', allFiles.length, totalBytes);

		try {
			for (const { file, relativePath } of allFiles) {
				const lastSlash = relativePath.lastIndexOf('/');
				if (lastSlash > 0) {
					const dirPath = joinPath(currentPath, relativePath.substring(0, lastSlash));
					if (!createdDirs.has(dirPath)) {
						await adbExec(ShellCmd.mkdir(dirPath));
						createdDirs.add(dirPath);
					}
				}
				const data = new Uint8Array(await file.arrayBuffer());
				await trackedPush(adb, joinPath(currentPath, relativePath), data);
				uploaded++;
			}
			await navigate(currentPath);
			if (!notice) notice = successMsg(`Uploaded ${plural(uploaded, 'file')}`);
		} catch (err) {
			notice = errorMsg(`Upload failed after ${uploaded} files: ${formatError(err)}`);
		} finally {
			endTransfer();
		}
		uploading = false;
	}

	function handleDragEnter(e: DragEvent) {
		e.preventDefault();
		dragCounter++;
		dragOver = true;
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		dragCounter--;
		if (dragCounter <= 0) {
			dragCounter = 0;
			dragOver = false;
		}
	}

	// Load initial directory on mount + cleanup blob URLs on unmount
	$effect(() => {
		untrack(() => navigate(DEVICE_PATHS.base, true));
		return () => {
			if (previewSrc) URL.revokeObjectURL(previewSrc);
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="p-6 flex flex-col h-full relative"
	ondragenter={handleDragEnter}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	{#if dragOver}
		<div
			class="absolute inset-0 z-50 bg-bg/80 border-2 border-dashed border-accent rounded-lg flex items-center justify-center pointer-events-none"
		>
			<span class="text-lg font-medium text-accent">Upload to {currentPath}</span>
		</div>
	{/if}

	<!-- Header -->
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-2xl font-bold text-text">File Browser</h2>
		<div class="flex items-center gap-2">
			<ActionButton onclick={uploadFiles} disabled={uploading} variant="primary">
				{uploading ? 'Uploading...' : 'Upload File'}
			</ActionButton>
			<ActionButton onclick={createFolder} disabled={creatingFolder} variant="secondary">
				{creatingFolder ? 'Creating...' : 'New Folder'}
			</ActionButton>
			<ActionButton onclick={uploadFolder} disabled={uploading} variant="primary">
				{uploading ? 'Uploading...' : 'Upload Folder'}
			</ActionButton>
			<ActionButton onclick={() => navigate(currentPath)} disabled={loading} variant="secondary">
				{loading ? 'Loading...' : 'Refresh'}
			</ActionButton>
		</div>
	</div>

	<!-- Search bar -->
	<div class="flex items-center gap-2 mb-4">
		<input
			type="text"
			bind:value={searchQuery}
			placeholder="Search files..."
			onkeydown={(e) => e.key === 'Enter' && doSearch()}
			class="flex-1 text-sm bg-surface text-text border border-border rounded px-3 py-1.5 placeholder:text-text-muted"
		/>
		<ActionButton onclick={doSearch} disabled={searching || !searchQuery.trim()} variant="primary">
			{searching ? 'Searching...' : 'Search'}
		</ActionButton>
		{#if searchResults !== null}
			<ActionButton onclick={clearSearch} variant="secondary">Clear</ActionButton>
		{/if}
	</div>

	<!-- Breadcrumb -->
	<div class="flex items-center gap-1 mb-4 text-sm flex-wrap min-h-[28px]">
		{#each pathSegments as segment, i}
			{#if i > 0}
				<span class="text-text-muted">/</span>
			{/if}
			{#if i === pathSegments.length - 1}
				<span class="text-text font-medium">{segment.name}</span>
			{:else}
				<button onclick={() => navigate(segment.path)} class="text-accent hover:underline">
					{segment.name}
				</button>
			{/if}
		{/each}
	</div>

	<!-- Error / status -->
	{#if notice}
		<StatusMessage notification={notice} />
	{/if}

	{#if folderProgress}
		<div class="text-xs text-text-muted mb-3">{folderProgress}</div>
	{/if}

	<!-- Table + Editor split view -->
	<div class="flex-1 flex gap-0 overflow-hidden">
		<!-- File listing -->
		<div class="flex-1 overflow-auto border border-border rounded-lg min-w-0">
			<table class="w-full text-sm">
				<thead class="bg-surface sticky top-0">
					<tr class="text-left">
						<th class="py-2 px-3 font-medium text-text-muted">
							<button onclick={() => toggleSort('name')} class="text-text-muted hover:text-text">
								Name{sortIndicator('name')}
							</button>
						</th>
						<th class="py-2 px-3 font-medium text-text-muted w-28 text-right">
							<button onclick={() => toggleSort('size')} class="text-text-muted hover:text-text">
								Size{sortIndicator('size')}
							</button>
						</th>
						<th class="py-2 px-3 font-medium text-text-muted w-48">
							<button onclick={() => toggleSort('mtime')} class="text-text-muted hover:text-text">
								Modified{sortIndicator('mtime')}
							</button>
						</th>
						<th class="py-2 px-3 font-medium text-text-muted w-44"></th>
					</tr>
				</thead>
				<tbody>
					{#if searching}
						<tr>
							<td colspan="4" class="py-8 text-center text-text-muted">Searching...</td>
						</tr>
					{:else if searchResults !== null}
						{#if searchResults.length === 0}
							<tr>
								<td colspan="4" class="py-8 text-center text-text-muted">No results found</td>
							</tr>
						{:else}
							{#each searchResults as result}
								{@const lastSlash = result.lastIndexOf('/')}
								{@const fileName = lastSlash >= 0 ? result.substring(lastSlash + 1) : result}
								{@const dirPath = lastSlash > 0 ? result.substring(0, lastSlash) : '/'}
								<tr class="border-t border-border hover:bg-surface-hover transition-colors">
									<td class="py-1.5 px-3" colspan="2">
										<button
											onclick={() => navigateToResult(result)}
											class="text-accent hover:underline text-left"
										>
											{fileName}
										</button>
									</td>
									<td
										class="py-1.5 px-3 text-text-muted text-xs font-mono truncate"
										colspan="2"
										title={dirPath}
									>
										{dirPath}
									</td>
								</tr>
							{/each}
							{#if searchResults.length >= 200}
								<tr>
									<td colspan="4" class="py-2 text-center text-text-muted text-xs">
										Results capped at 200. Refine your search for more specific results.
									</td>
								</tr>
							{/if}
						{/if}
					{:else if loading}
						<tr>
							<td colspan="4" class="py-8 text-center text-text-muted">Loading...</td>
						</tr>
					{:else if sortedEntries.length === 0}
						{#if currentPath !== '/'}
							<tr class="border-t border-border hover:bg-surface-hover transition-colors">
								<td colspan="4" class="py-1.5 px-3">
									<button
										onclick={navigateUp}
										class="text-accent hover:underline flex items-center gap-1.5"
									>
										<span class="text-text-muted">&#8617;</span> ..
									</button>
								</td>
							</tr>
						{/if}
						<tr>
							<td colspan="4" class="py-8 text-center text-text-muted">Empty directory</td>
						</tr>
					{:else}
						{#if currentPath !== '/'}
							<tr class="border-t border-border hover:bg-surface-hover transition-colors">
								<td colspan="4" class="py-1.5 px-3">
									<button
										onclick={navigateUp}
										class="text-accent hover:underline flex items-center gap-1.5"
									>
										<span class="text-text-muted">&#8617;</span> ..
									</button>
								</td>
							</tr>
						{/if}
						{#each sortedEntries as entry}
							<tr class="border-t border-border hover:bg-surface-hover transition-colors">
								<td class="py-1.5 px-3">
									{#if entry.isDirectory}
										<button
											onclick={() => handleEntryClick(entry)}
											class="text-accent hover:underline flex items-center gap-1.5"
										>
											<span class="text-text-muted">&#128193;</span>
											{entry.name}
										</button>
									{:else}
										<span class="flex items-center gap-1.5 text-text">
											<span class="text-text-muted">&#128196;</span>
											{entry.name}
										</span>
									{/if}
								</td>
								<td class="py-1.5 px-3 text-right text-text-muted tabular-nums">
									{entry.isDirectory ? '\u2014' : formatSize(entry.size)}
								</td>
								<td class="py-1.5 px-3 text-text-muted tabular-nums">
									{formatDate(entry.mtime)}
								</td>
								<td class="py-1.5 px-3">
									<div class="flex items-center gap-2">
										{#if entry.isFile}
											{#if isTextFile(entry.name)}
												<ActionButton
													onclick={() => openEditor(joinPath(currentPath, entry.name))}
													variant="subtle"
													size="xs"
												>
													Edit
												</ActionButton>
											{/if}
											{#if isImageFile(entry.name)}
												<ActionButton
													onclick={() => previewImage(entry)}
													disabled={previewLoading !== null}
													variant="subtle"
													size="xs"
												>
													{previewLoading === entry.name ? '...' : 'Preview'}
												</ActionButton>
											{/if}
											<ActionButton
												onclick={() => downloadFile(entry)}
												disabled={downloadingFile !== null ||
													downloadingFolder !== null ||
													renamingEntry !== null}
												variant="subtle"
												size="xs"
											>
												{downloadingFile === entry.name ? '...' : 'Download'}
											</ActionButton>
										{:else if entry.isDirectory}
											<ActionButton
												onclick={() => downloadFolder(entry)}
												disabled={downloadingFile !== null ||
													downloadingFolder !== null ||
													renamingEntry !== null}
												variant="subtle"
												size="xs"
												title="Download folder as a zip"
											>
												{downloadingFolder === entry.name ? '...' : 'Download'}
											</ActionButton>
										{/if}
										<ActionButton
											onclick={() => renameEntry(entry)}
											disabled={renamingEntry !== null || deletingEntry !== null}
											variant="subtle"
											size="xs"
											title={entry.isDirectory ? 'Rename folder' : 'Rename file'}
										>
											{renamingEntry === entry.name ? '...' : 'Rename'}
										</ActionButton>
										<ActionButton
											onclick={() => deleteEntry(entry)}
											disabled={deletingEntry !== null || renamingEntry !== null}
											variant="danger"
											size="xs"
										>
											{deletingEntry === entry.name ? '...' : 'Delete'}
										</ActionButton>
									</div>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Editor panel -->
		{#if editorPath}
			<div class="w-1/2 border border-border rounded-lg ml-2 flex flex-col min-w-0">
				<!-- Editor header -->
				<div
					class="flex items-center justify-between p-2 bg-surface border-b border-border shrink-0"
				>
					<div class="flex items-center gap-2 min-w-0">
						<span class="text-sm font-mono text-text truncate" title={editorPath}>
							{editorFileName()}{editorDirty ? ' *' : ''}
						</span>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<ActionButton
							onclick={saveEditor}
							disabled={!editorDirty || editorSaving}
							variant="primary"
							size="xs"
						>
							{editorSaving ? 'Saving...' : 'Save'}
						</ActionButton>
						<ActionButton onclick={closeEditor} variant="subtle" size="xs" title="Close editor">
							Close
						</ActionButton>
					</div>
				</div>

				<!-- Editor content -->
				{#if editorLoading}
					<div class="flex-1 flex items-center justify-center text-text-muted text-sm">
						Loading...
					</div>
				{:else}
					<textarea
						bind:value={editorContent}
						class="flex-1 w-full p-3 bg-bg text-text font-mono text-sm resize-none border-none outline-none"
						spellcheck="false"
					></textarea>
				{/if}

				<!-- Editor footer -->
				{#if editorError}
					<div
						class="px-2 py-1 text-xs border-t border-border shrink-0 {editorError === 'Saved'
							? 'text-success'
							: 'text-red-400'}"
					>
						{editorError}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Footer info -->
	<div class="mt-2 text-xs text-text-muted flex justify-between">
		<span>{entries.length} items</span>
		<span class="font-mono">{currentPath}</span>
	</div>
</div>

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}

<ConfirmDialog bind:this={confirmDialog} />
