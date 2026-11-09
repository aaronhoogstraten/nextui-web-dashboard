<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { Adb } from '@yume-chan/adb';
	import JSZip from 'jszip';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { pullFile } from '$lib/adb/file-ops.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import { adbExec, getPlatform } from '$lib/stores/connection.svelte.js';
	import {
		beginTransfer,
		endTransfer,
		skipTransferFile,
		trackedPull,
		trackedPush
	} from '$lib/stores/transfer.svelte.js';
	import {
		getLastSavesScan,
		listFolderGames,
		listRomSystemFolders,
		rememberSavesScan,
		scanSaves,
		type RomSystemFolder
	} from '$lib/saves/scan.js';
	import { applyRenamePlan, planSaveLink, type RenamePlan } from '$lib/roms/game-rename.js';
	import {
		slotLabel,
		type ListedGame,
		type GameSaves,
		type ListedFile,
		type SaveFile,
		type SystemSaves
	} from '$lib/saves/matching.js';
	import {
		allBackupFiles,
		backupPath,
		fileDeletion,
		gameBackupFiles,
		gameDeletion,
		restorePath,
		safeFileName
	} from '$lib/saves/actions.js';
	import {
		errorMsg,
		fileName,
		formatError,
		formatSize,
		pickFile,
		plural,
		successMsg,
		downloadBlob,
		type Notification
	} from '$lib/utils.js';
	import ActionButton from './ActionButton.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Modal from './Modal.svelte';
	import RenamePlanDialog from './RenamePlanDialog.svelte';
	import StatusMessage from './StatusMessage.svelte';

	let { adb }: { adb: Adb } = $props();

	const lastScan = untrack(() => getLastSavesScan(adb));
	let systems: SystemSaves[] = $state.raw(lastScan ?? []);
	let hasScanned = $state(lastScan !== undefined);
	let refreshing = $state(false);
	let notice: Notification | null = $state(null);
	/** The running download, restore, delete or link; only one at a time */
	let busy: 'download' | 'restore' | 'delete' | 'link' | null = $state(null);
	let confirmDialog: ConfirmDialog;

	// Kept apart from the scan results, so a rescan can't collapse anything
	const expanded = new SvelteSet<string>();
	/** Object URLs by preview revision; empty while loading or if the read failed */
	const previews = new SvelteMap<string, string>();

	let scanId = 0;
	let stopped = false;

	const totalGames = $derived(systems.reduce((sum, s) => sum + s.games.length, 0));
	const totalOrphans = $derived(systems.reduce((sum, s) => sum + s.orphans.length, 0));

	async function scan(quiet: boolean) {
		const id = ++scanId;
		if (!quiet) {
			refreshing = true;
			notice = null;
		}
		try {
			const result = await scanSaves(adb);
			if (stopped || id !== scanId) return;
			systems = result;
			hasScanned = true;
			rememberSavesScan(adb, result);
			// Free thumbnails of previews this scan no longer lists: deleted, moved or rewritten
			const listed = result
				.flatMap((s) => [...s.games, ...s.orphans])
				.flatMap((g) => [...g.previews.values()].map(previewKey));
			for (const [key, url] of [...previews]) {
				if (listed.includes(key)) continue;
				if (url) URL.revokeObjectURL(url);
				previews.delete(key);
			}
			for (const system of result) {
				for (const game of [...system.games, ...system.orphans]) {
					if (expanded.has(game.key)) void loadPreviews(game);
				}
			}
		} catch (e) {
			if (!stopped && id === scanId) notice = errorMsg(`Failed to scan saves: ${formatError(e)}`);
		} finally {
			if (id === scanId) refreshing = false;
		}
	}

	function toggle(key: string) {
		if (!expanded.delete(key)) expanded.add(key);
	}

	function toggleGame(game: GameSaves) {
		toggle(game.key);
		if (expanded.has(game.key)) void loadPreviews(game);
	}

	const previewKey = (file: ListedFile) => `${file.path}:${file.mtime}`;

	async function loadPreviews(game: GameSaves) {
		for (const file of game.previews.values()) {
			const key = previewKey(file);
			if (stopped || previews.has(key)) continue;
			previews.set(key, '');
			try {
				const data = await pullFile(adb, file.path);
				if (stopped) return;
				// NextUI's .bmp previews hold PNG data, so the type is left to the
				// browser, which decodes images by their content
				previews.set(key, URL.createObjectURL(new Blob([data])));
			} catch {
				// pullFile logged it; the row just has no thumbnail
			}
		}
	}

	function previewFor(game: GameSaves, file: SaveFile): string {
		const preview = file.slot === null ? undefined : game.previews.get(file.slot);
		return preview ? (previews.get(previewKey(preview)) ?? '') : '';
	}

	function typeLabel(file: SaveFile): string {
		if (file.kind === 'state') return slotLabel(file.slot ?? 0);
		return file.kind === 'rtc' ? 'Clock' : 'Save';
	}

	function formatDate(mtime: bigint): string {
		if (mtime === 0n) return '';
		return new Date(Number(mtime) * 1000).toLocaleString(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		});
	}

	function summarize(files: SaveFile[]): string {
		const states = files.filter((f) => f.kind === 'state').length;
		const saves = files.length - states;
		const parts = [];
		if (saves > 0) parts.push(plural(saves, 'save'));
		if (states > 0) parts.push(plural(states, 'state'));
		return parts.join(', ');
	}

	function lastModified(game: GameSaves): bigint {
		return game.files.reduce((latest, f) => (f.mtime > latest ? f.mtime : latest), 0n);
	}

	// --- Download ---

	async function downloadFile(file: ListedFile) {
		busy = 'download';
		notice = null;
		beginTransfer('download', 1, Number(file.size));
		try {
			downloadBlob(new Blob([await trackedPull(adb, file.path)]), file.name);
		} catch (e) {
			notice = errorMsg(`Download failed: ${formatError(e)}`);
		} finally {
			endTransfer();
			busy = null;
		}
	}

	/** Pull files into a zip laid out like the card, so Restore can put them back. */
	async function downloadZip(files: ListedFile[], zipName: string) {
		busy = 'download';
		notice = null;
		const zip = new JSZip();
		const failed: string[] = [];
		beginTransfer(
			'download',
			files.length,
			files.reduce((sum, f) => sum + Number(f.size), 0)
		);
		try {
			for (const file of files) {
				try {
					const data = await trackedPull(adb, file.path);
					zip.file(backupPath(file.path, DEVICE_PATHS.base), data, {
						date: file.mtime > 0n ? new Date(Number(file.mtime) * 1000) : undefined
					});
				} catch {
					// One unreadable file shouldn't discard the rest; pullFile logged it
					failed.push(file.name);
					skipTransferFile(Number(file.size));
				}
			}
			if (failed.length === files.length) throw new Error('none of the files could be read');
			const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
			downloadBlob(blob, zipName);
			const summary = `Downloaded ${zipName} (${plural(files.length - failed.length, 'file')}, ${formatSize(blob.size)})`;
			notice =
				failed.length > 0
					? errorMsg(`${summary}. Could not read: ${failed.join(', ')}`)
					: successMsg(summary);
		} catch (e) {
			notice = errorMsg(`Download failed: ${formatError(e)}`);
		} finally {
			endTransfer();
			busy = null;
		}
	}

	function backUpAll() {
		const date = new Date().toISOString().slice(0, 10);
		const platform = getPlatform();
		const name = `NextUI saves${platform ? ` ${platform}` : ''} ${date}.zip`;
		void downloadZip(allBackupFiles(systems), name);
	}

	// --- Restore ---

	async function restoreBackup() {
		const picked = await pickFile({ accept: '.zip' });
		if (!picked) return;
		busy = 'restore';
		notice = null;
		let changed = false;
		try {
			const zip = await JSZip.loadAsync(picked);
			const entries = Object.values(zip.files).filter((e) => !e.dir);
			const restorable = entries.flatMap((entry) => {
				const path = restorePath(entry.name);
				return path ? [{ entry, path }] : [];
			});
			if (restorable.length === 0) {
				notice = errorMsg(
					`${picked.name} has no NextUI save files in it. Restore takes a zip downloaded from this view.`
				);
				return;
			}

			// vfat ignores case, so a differently cased path still replaces the file
			const onDevice = new Set(
				allBackupFiles(systems).map((f) => backupPath(f.path, DEVICE_PATHS.base).toLowerCase())
			);
			const replacing = restorable.filter((r) => onDevice.has(r.path.toLowerCase())).length;
			const skipped = entries.length - restorable.length;
			const confirmed = await confirmDialog.show({
				title: `Restore from ${picked.name}?`,
				summary:
					`${plural(restorable.length, 'file')} will be copied to the device` +
					(replacing > 0 ? `, replacing ${replacing} already there.` : '.'),
				advice:
					'Close any game running on the device first. NextUI saves when a game closes, which would overwrite what you restore.',
				details: [
					...(skipped > 0
						? [
								`${plural(skipped, 'other file')} in the zip will be skipped, as they are not save data.`
							]
						: []),
					'Files on the device that are not in the backup are left alone.'
				],
				confirmLabel: 'Restore',
				confirmVariant: replacing > 0 ? 'warning' : 'primary'
			});
			if (!confirmed) return;

			const contents = await Promise.all(
				restorable.map(async (r) => ({ ...r, data: await r.entry.async('uint8array') }))
			);
			const failed: string[] = [];
			beginTransfer(
				'upload',
				contents.length,
				contents.reduce((sum, c) => sum + c.data.byteLength, 0)
			);
			try {
				const dirs = new Set(contents.map((c) => c.path.slice(0, c.path.lastIndexOf('/'))));
				for (const dir of dirs) await adbExec(ShellCmd.mkdir(`${DEVICE_PATHS.base}/${dir}`));
				for (const { path, data } of contents) {
					try {
						await trackedPush(adb, `${DEVICE_PATHS.base}/${path}`, data);
						changed = true;
					} catch {
						failed.push(path);
						skipTransferFile(data.byteLength);
					}
				}
			} finally {
				endTransfer();
			}
			const summary = `Restored ${plural(contents.length - failed.length, 'file')} from ${picked.name}`;
			notice =
				failed.length > 0
					? errorMsg(`${summary}. Could not write: ${failed.join(', ')}`)
					: successMsg(summary);
		} catch (e) {
			notice = errorMsg(`Restore failed: ${formatError(e)}`);
		} finally {
			busy = null;
		}
		if (changed) await scan(true);
	}

	// --- Delete ---

	async function removeFiles(paths: string[], description: string) {
		busy = 'delete';
		notice = null;
		try {
			// rm -f is silent on success, so any output is an error message
			const output = (await adbExec(ShellCmd.rmMany(paths))).trim();
			if (output) throw new Error(output);
			notice = successMsg(`Deleted ${description}`);
		} catch (e) {
			notice = errorMsg(`Delete failed: ${formatError(e)}`);
		} finally {
			busy = null;
		}
		await scan(true);
	}

	const CANNOT_UNDO = 'This cannot be undone. Download a copy first if you might want it back.';

	async function deleteFile(game: GameSaves, file: SaveFile) {
		const plan = fileDeletion(game, file);
		const confirmed = await confirmDialog.show({
			title: `Delete ${typeLabel(file).toLowerCase()} for ${game.title}?`,
			summary: file.name,
			advice:
				file.owners > 1
					? 'More than one ROM uses this file, so deleting it affects all of them.'
					: undefined,
			details: [
				...(plan.paths.length > 1 ? ['Its slot preview and resume data go with it.'] : []),
				CANNOT_UNDO
			],
			confirmLabel: 'Delete',
			confirmVariant: 'danger'
		});
		if (!confirmed) return;

		const paths = [...plan.paths];
		if (plan.lastSlotCheck) {
			// Leave Resume pointing at a remaining slot rather than the deleted one
			try {
				const text = new TextDecoder().decode(await pullFile(adb, plan.lastSlotCheck.file.path));
				if (Number.parseInt(text.trim(), 10) === plan.lastSlotCheck.slot) {
					paths.push(plan.lastSlotCheck.file.path);
				}
			} catch {
				// Unreadable: leave it, NextUI copes with a missing state
			}
		}
		await removeFiles(paths, file.name);
	}

	async function deleteGame(game: GameSaves) {
		const plan = gameDeletion(game);
		if (plan.paths.length === 0) {
			notice = errorMsg(
				`Nothing to delete for ${game.title}: its files are shared with another ROM. Delete them one at a time if you mean to.`
			);
			return;
		}
		const removed = game.files.filter((f) => f.owners === 1);
		const withSlotData = plan.paths.length > removed.length;
		const summary =
			removed.length === 0
				? 'Its slot previews and resume data will be deleted.'
				: `${summarize(removed)} will be deleted${withSlotData ? ', along with slot previews and resume data' : ''}.`;
		const confirmed = await confirmDialog.show({
			title: `Delete all saves for ${game.title}?`,
			summary,
			advice:
				plan.kept.length > 0
					? `${plural(plan.kept.length, 'file')} shared with another ROM will be kept. Delete them one at a time if you mean to.`
					: undefined,
			details: [CANNOT_UNDO],
			confirmLabel: 'Delete All',
			confirmVariant: 'danger'
		});
		if (confirmed) await removeFiles(plan.paths, `saves for ${game.title}`);
	}

	async function deleteOther(file: ListedFile) {
		const confirmed = await confirmDialog.show({
			title: `Delete ${file.name}?`,
			summary:
				'The emulator wrote this file and may still need it, for example as a memory card holding saves for several games.',
			details: [CANNOT_UNDO],
			confirmLabel: 'Delete',
			confirmVariant: 'danger'
		});
		if (confirmed) await removeFiles([file.path], file.name);
	}

	// --- Link to ROM ---

	interface LinkSource {
		system: SystemSaves;
		game: GameSaves;
	}

	let linkSource: LinkSource | null = $state.raw(null);
	let linkFolders: RomSystemFolder[] = $state.raw([]);
	let linkTag = $state('');
	let linkGames: ListedGame[] = $state.raw([]);
	let linkFilter = $state('');
	let linkLoading = $state(false);
	let linkError = $state('');
	let linkPlan: { target: ListedGame; plan: RenamePlan } | null = $state.raw(null);

	const linkSystems = $derived.by(() => {
		// One entry per tag; GBA can have several folders
		const firstPerTag = linkFolders.filter(
			(folder, i) => linkFolders.findIndex((f) => f.tag === folder.tag) === i
		);
		const systems = firstPerTag.map((f): [string, string] => [f.tag, f.name]);
		// The saves' own system may have no ROM folder left, but the picker starts on it
		const source = linkSource?.system;
		if (source && !systems.some(([tag]) => tag === source.tag)) {
			systems.push([source.tag, source.name]);
		}
		return systems.sort((a, b) => a[1].localeCompare(b[1]));
	});

	function sharedPrefixLength(a: string, b: string): number {
		let i = 0;
		while (i < a.length && i < b.length && a[i] === b[i]) i++;
		return i;
	}

	/** Games with one filename to link to, closest to the saves' name first */
	const linkCandidates = $derived.by(() => {
		if (!linkSource) return [];
		const title = linkSource.game.title.toLowerCase();
		const filter = linkFilter.trim().toLowerCase();
		return linkGames
			.filter((g) => g.names.length === 1)
			.filter((g) => !filter || `${g.title}\n${g.names[0]}`.toLowerCase().includes(filter))
			.map((game) => ({ game, score: sharedPrefixLength(title, game.title.toLowerCase()) }))
			.sort((a, b) => b.score - a.score || a.game.title.localeCompare(b.game.title))
			.map((c) => c.game);
	});

	async function openLink(system: SystemSaves, game: GameSaves) {
		linkSource = { system, game };
		linkTag = system.tag;
		linkFilter = '';
		linkGames = [];
		linkError = '';
		linkLoading = true;
		try {
			linkFolders = await listRomSystemFolders(adb);
			await loadLinkGames();
		} catch (e) {
			linkError = `Could not list ROMs: ${formatError(e)}`;
		} finally {
			linkLoading = false;
		}
	}

	async function loadLinkGames() {
		const tag = linkTag;
		linkLoading = true;
		linkError = '';
		try {
			const games: ListedGame[] = [];
			for (const folder of linkFolders.filter((f) => f.tag === tag)) {
				games.push(...(await listFolderGames(adb, folder.path)));
			}
			if (tag === linkTag) linkGames = games;
		} catch (e) {
			if (tag === linkTag) linkError = `Could not list ROMs: ${formatError(e)}`;
		} finally {
			if (tag === linkTag) linkLoading = false;
		}
	}

	async function chooseLinkTarget(target: ListedGame) {
		if (!linkSource) return;
		linkLoading = true;
		linkError = '';
		try {
			const plan = await planSaveLink(adb, linkSource.game, linkSource.system.tag, {
				tag: linkTag,
				fullName: target.names[0]
			});
			linkPlan = { target, plan };
		} catch (e) {
			linkError = `Could not check the files: ${formatError(e)}`;
		} finally {
			linkLoading = false;
		}
	}

	function closeLink() {
		linkSource = null;
		linkPlan = null;
	}

	async function confirmLink() {
		if (!linkPlan) return;
		const { target, plan } = linkPlan;
		busy = 'link';
		notice = null;
		try {
			const result = await applyRenamePlan(adb, plan);
			const summary = `Linked ${plural(result.moved, 'file')} to ${target.names[0]}`;
			notice =
				result.failures.length > 0
					? errorMsg(
							`${summary}, but could not move: ${result.failures.map((f) => fileName(f.path)).join(', ')}`
						)
					: successMsg(summary);
		} catch (e) {
			notice = errorMsg(`Link failed: ${formatError(e)}`);
		} finally {
			busy = null;
			closeLink();
		}
		await scan(true);
	}

	$effect(() => {
		untrack(() => scan(lastScan !== undefined));
		return () => {
			stopped = true;
			for (const url of previews.values()) if (url) URL.revokeObjectURL(url);
		};
	});
</script>

{#snippet gameList(system: SystemSaves, games: GameSaves[])}
	<div class="space-y-1">
		{#each games as game (game.key)}
			<div class="border border-border rounded overflow-hidden">
				<button
					onclick={() => toggleGame(game)}
					class="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface-hover text-left"
					title={game.romNames.join('\n')}
				>
					<span class="text-sm text-text truncate">{game.title}</span>
					<span class="flex items-center gap-3 shrink-0 text-xs text-text-muted">
						<span>{summarize(game.files)}</span>
						<span class="w-36 text-right tabular-nums">{formatDate(lastModified(game))}</span>
						<span>{expanded.has(game.key) ? '▲' : '▼'}</span>
					</span>
				</button>

				{#if expanded.has(game.key)}
					<div class="flex justify-end gap-2 px-2 py-1.5 border-t border-border">
						{#if game.romNames.length === 0}
							<ActionButton
								onclick={() => openLink(system, game)}
								disabled={busy !== null}
								variant="primary"
								size="xs"
								title="Rename these files so a ROM on the device loads them"
							>
								Link to ROM...
							</ActionButton>
						{/if}
						<ActionButton
							onclick={() =>
								downloadZip(gameBackupFiles(game), `${safeFileName(game.title)} saves.zip`)}
							disabled={busy !== null}
							variant="subtle"
							size="xs"
						>
							Download All
						</ActionButton>
						<ActionButton
							onclick={() => deleteGame(game)}
							disabled={busy !== null}
							variant="danger"
							size="xs"
						>
							Delete All
						</ActionButton>
					</div>
					<table class="w-full text-sm border-t border-border">
						<thead>
							<tr class="text-left text-text-muted">
								<th class="py-1 px-2 font-medium w-24"></th>
								<th class="py-1 px-2 font-medium w-24">Type</th>
								<th class="py-1 px-2 font-medium">File</th>
								<th class="py-1 px-2 font-medium w-20 text-right">Size</th>
								<th class="py-1 px-2 font-medium w-40 text-right">Modified</th>
								<th class="py-1 px-2 font-medium w-36"></th>
							</tr>
						</thead>
						<tbody>
							{#each game.files as file (file.path)}
								{@const preview = previewFor(game, file)}
								<tr class="border-t border-border">
									<td class="py-1 px-2">
										{#if preview}
											<img src={preview} alt="" class="h-12 rounded" />
										{/if}
									</td>
									<td class="py-1 px-2 text-text whitespace-nowrap">{typeLabel(file)}</td>
									<td
										class="py-1 px-2 font-mono text-xs text-text-muted break-all"
										title={file.path}
									>
										{file.name}
										{#if file.core}
											<span class="ml-1 font-sans text-text-muted">({file.core})</span>
										{/if}
										{#if file.owners > 1}
											<span
												class="ml-1 font-sans text-warning"
												title="More than one ROM uses this name, so this file can't be tied to just one of them"
											>
												Shared
											</span>
										{/if}
									</td>
									<td class="py-1 px-2 text-right text-text-muted text-xs tabular-nums">
										{formatSize(file.size)}
									</td>
									<td class="py-1 px-2 text-right text-text-muted text-xs tabular-nums">
										{formatDate(file.mtime)}
									</td>
									<td class="py-1 px-2">
										<div class="flex justify-end gap-2">
											<ActionButton
												onclick={() => downloadFile(file)}
												disabled={busy !== null}
												variant="subtle"
												size="xs"
											>
												Download
											</ActionButton>
											<ActionButton
												onclick={() => deleteFile(game, file)}
												disabled={busy !== null}
												variant="danger"
												size="xs"
											>
												Delete
											</ActionButton>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{/each}
	</div>
{/snippet}

<div class="p-6 flex flex-col h-full">
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-2xl font-bold text-text">Saves</h2>
		<div class="flex items-center gap-2">
			<ActionButton
				onclick={restoreBackup}
				disabled={busy !== null || !hasScanned}
				variant="secondary"
				title="Copy saves back to the device from a zip downloaded here"
			>
				{busy === 'restore' ? 'Restoring...' : 'Restore...'}
			</ActionButton>
			<ActionButton
				onclick={backUpAll}
				disabled={busy !== null || systems.length === 0}
				variant="primary"
				title="Download every save, state and slot preview as one zip"
			>
				Back Up All
			</ActionButton>
			<ActionButton onclick={() => scan(false)} disabled={refreshing} variant="secondary">
				{refreshing ? 'Scanning...' : 'Refresh'}
			</ActionButton>
		</div>
	</div>

	{#if notice}
		<StatusMessage notification={notice} />
	{/if}

	<div class="text-xs text-text-muted mb-3">
		Source: <span class="font-mono">{DEVICE_PATHS.saves}/</span> and
		<span class="font-mono">{DEVICE_PATHS.sharedUserdata}/</span>
		{#if hasScanned}
			<span class="ml-2">
				{plural(totalGames, 'game')} with saves{#if totalOrphans > 0}, {totalOrphans} without a matching
					ROM{/if}
			</span>
		{/if}
	</div>

	<div class="flex-1 overflow-auto">
		{#if !hasScanned}
			<div class="text-sm text-text-muted py-8 text-center">
				{refreshing || !notice ? 'Scanning saves...' : 'Could not read saves from the device.'}
			</div>
		{:else if systems.length === 0}
			<div class="text-sm text-text-muted py-8 text-center">No saves or save states found.</div>
		{:else}
			<div class="space-y-2">
				{#each systems as system (system.tag)}
					<div class="border border-border rounded-lg overflow-hidden">
						<button
							onclick={() => toggle(system.tag)}
							class="w-full flex items-center justify-between p-3 bg-surface hover:bg-surface-hover text-left"
						>
							<span class="font-semibold text-text">
								{system.name}
								<span class="ml-1 text-xs font-normal text-text-muted">{system.tag}</span>
							</span>
							<span class="flex items-center gap-3 text-sm">
								{#if system.orphans.length > 0}
									<span class="text-warning">{system.orphans.length} without ROM</span>
								{/if}
								{#if system.games.length > 0}
									<span class="text-success">{plural(system.games.length, 'game')}</span>
								{/if}
								<span class="text-text-muted">{expanded.has(system.tag) ? '▲' : '▼'}</span>
							</span>
						</button>

						{#if expanded.has(system.tag)}
							<div class="p-3 space-y-4">
								{#if system.games.length > 0}
									{@render gameList(system, system.games)}
								{/if}

								{#if system.orphans.length > 0}
									<div>
										<h3 class="text-sm font-semibold text-warning">No matching ROM</h3>
										<p class="text-xs text-text-muted mb-2">
											NextUI won't load these for any ROM in this system. This usually means the ROM
											was renamed, moved or deleted.
										</p>
										{@render gameList(system, system.orphans)}
									</div>
								{/if}

								{#if system.other.length > 0}
									<div>
										<h3 class="text-sm font-semibold text-text">Other save data</h3>
										<p class="text-xs text-text-muted mb-2">
											Written by the emulator and not named after a ROM, such as memory cards.
										</p>
										<ul class="space-y-1">
											{#each system.other as file (file.path)}
												<li class="flex items-center justify-between gap-3 text-xs text-text-muted">
													<span class="font-mono break-all" title={file.path}>{file.name}</span>
													<span class="flex items-center gap-2 shrink-0">
														<span class="tabular-nums">{formatSize(file.size)}</span>
														<ActionButton
															onclick={() => downloadFile(file)}
															disabled={busy !== null}
															variant="subtle"
															size="xs"
														>
															Download
														</ActionButton>
														<ActionButton
															onclick={() => deleteOther(file)}
															disabled={busy !== null}
															variant="danger"
															size="xs"
														>
															Delete
														</ActionButton>
													</span>
												</li>
											{/each}
										</ul>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<ConfirmDialog bind:this={confirmDialog} />

{#if linkSource && linkPlan}
	<RenamePlanDialog
		title={`Link saves for "${linkSource.game.title}" to ${linkPlan.target.names[0]}?`}
		plan={linkPlan.plan}
		confirmLabel="Link"
		advice="If this ROM is a different version from the one these saves came from, its states may not load correctly. In-game saves usually carry over."
		busy={busy === 'link'}
		onconfirm={confirmLink}
		oncancel={() => (linkPlan = null)}
	/>
{:else if linkSource}
	<Modal onclose={closeLink} maxWidth="max-w-xl">
		<div class="p-6 flex flex-col max-h-[80vh]">
			<h3 class="text-lg font-bold text-text mb-1">Link to ROM</h3>
			<p class="text-sm text-text-muted mb-3">
				Pick the ROM that should load the saves for
				<span class="text-text">{linkSource.game.title}</span>.
			</p>
			<div class="flex gap-2 mb-3">
				<select
					bind:value={linkTag}
					onchange={loadLinkGames}
					class="bg-surface border border-border rounded px-2 py-1 text-sm text-text"
					aria-label="System"
				>
					{#each linkSystems as [tag, name] (tag)}
						<option value={tag}>{name} ({tag})</option>
					{/each}
				</select>
				<input
					bind:value={linkFilter}
					placeholder="Filter ROMs"
					class="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-1 text-sm text-text"
				/>
			</div>
			{#if linkTag !== linkSource.system.tag}
				<p class="text-xs text-text-muted mb-2">
					Only saves move to another system. States stay, as they only load in the emulator that
					made them.
				</p>
			{/if}
			{#if linkError}
				<p class="text-xs text-warning mb-2">{linkError}</p>
			{/if}
			<div class="flex-1 overflow-auto border border-border rounded min-h-32">
				{#if linkLoading}
					<div class="text-sm text-text-muted py-6 text-center">Loading...</div>
				{:else if linkCandidates.length === 0}
					<div class="text-sm text-text-muted py-6 text-center">No ROMs found.</div>
				{:else}
					{#each linkCandidates as game (game.path)}
						<button
							onclick={() => chooseLinkTarget(game)}
							class="w-full text-left px-3 py-1.5 border-t border-border first:border-t-0 hover:bg-surface-hover"
						>
							<div class="text-sm text-text truncate">{game.title}</div>
							<div class="text-xs text-text-muted font-mono truncate">{game.names[0]}</div>
						</button>
					{/each}
				{/if}
			</div>
			<div class="flex justify-end mt-4">
				<ActionButton onclick={closeLink} variant="secondary">Cancel</ActionButton>
			</div>
		</div>
	</Modal>
{/if}
