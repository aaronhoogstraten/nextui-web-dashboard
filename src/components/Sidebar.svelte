<script lang="ts">
	import {
		getConnection,
		getStatus,
		getError,
		isBusy,
		isConnected,
		connect,
		disconnect,
		getNextUIVersion,
		getPlatform
	} from '$lib/stores/connection.svelte.js';
	import { hasWebUSB, getBrowserRecommendation } from '$lib/adb/connection.js';
	import { toggleTheme, isDark } from '$lib/stores/theme.svelte.js';
	import { base } from '$app/paths';

	interface NavItem {
		id: string;
		label: string;
	}

	let {
		activeView = 'welcome',
		onNavigate
	}: { activeView: string; onNavigate: (view: string) => void } = $props();

	const webUsbSupported = hasWebUSB();
	const deviceLabel = $derived.by(() => {
		const conn = getConnection();
		const name = conn?.device.product ?? conn?.device.serial ?? 'Connected';
		const p = getPlatform();
		return p ? `${name} (${p})` : name;
	});

	const navItems: NavItem[] = [
		{ id: 'roms', label: 'ROMs' },
		{ id: 'bios', label: 'BIOS' },
		{ id: 'overlays', label: 'Overlays' },
		{ id: 'cheats', label: 'Cheats' },
		{ id: 'collections', label: 'Collections' },
		{ id: 'screenshots', label: 'Screenshots' },
		{ id: 'files', label: 'File Browser' },
		{ id: 'logs', label: 'Download Logs' }
	];
</script>

<aside
	class="w-60 bg-sidebar text-text h-screen flex flex-col shrink-0 border-r border-border shadow-[2px_0_12px_rgba(0,0,0,0.3)] z-10"
>
	<!-- Header -->
	<div class="p-4 border-b border-border flex items-center justify-between">
		<h1 class="text-xl font-bold">NextUI Dashboard</h1>
		<button
			onclick={toggleTheme}
			class="text-text-muted hover:text-text p-1 rounded"
			title={isDark() ? 'Switch to light mode' : 'Switch to dark mode'}
		>
			{isDark() ? '\u2600' : '\u263E'}
		</button>
	</div>

	<!-- Connection -->
	<div class="p-4 border-b border-border">
		<div class="text-sm text-text-muted mb-2">Device</div>
		{#if isConnected()}
			<div class="text-base text-success truncate" title={getStatus()}>
				{deviceLabel}
			</div>
			{#if getNextUIVersion()}
				<div class="text-sm text-text-muted mb-2">{getNextUIVersion()}</div>
			{/if}
			<button
				onclick={disconnect}
				disabled={isBusy()}
				class="w-full text-base bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-1.5 rounded"
			>
				Disconnect
			</button>
		{:else}
			<div class="text-base text-text-muted mb-2">
				{isBusy() ? 'Connecting...' : 'No device'}
			</div>
			{#if getError()}
				<div class="text-sm text-red-400 mb-2">{getError()}</div>
			{/if}
			<button
				onclick={connect}
				disabled={isBusy() || !webUsbSupported}
				class="w-full text-base bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded"
			>
				{isBusy() ? 'Connecting...' : 'Connect'}
			</button>
			{#if !webUsbSupported}
				<div class="text-sm text-warning mt-2">
					WebUSB not available. Use Chrome, Edge, or another Chromium browser.
				</div>
			{/if}
		{/if}
	</div>

	<!-- Navigation -->
	<nav class="flex-1 p-2">
		{#each navItems as item}
			<button
				onclick={() => onNavigate(item.id)}
				disabled={!isConnected()}
				class="w-full text-left px-3 py-2 rounded text-base mb-0.5 transition-colors
					{activeView === item.id
					? 'bg-surface-hover text-text'
					: isConnected()
						? 'text-text-muted hover:bg-surface hover:text-text'
						: 'text-text-muted opacity-50 cursor-not-allowed'}"
			>
				{item.label}
			</button>
		{/each}
	</nav>

	<!-- External links -->
	<div class="p-3 border-t border-border flex items-center gap-3">
		<a
			href="https://nextui.loveretro.games/"
			target="_blank"
			rel="noopener noreferrer"
			class="opacity-60 hover:opacity-100 transition-opacity"
			title="NextUI Website"
		>
			<img
				src="{base}/{isDark() ? 'nextui_vectorized_shadow.svg' : 'nextui_vectorized_shadow_dark.svg'}"
				alt="NextUI"
				class="w-6 h-6"
			/>
		</a>
		<a
			href="https://github.com/aaronhoogstraten/nextui-web-dashboard"
			target="_blank"
			rel="noopener noreferrer"
			class="text-text-muted hover:text-text transition-colors"
			title="View on GitHub"
		>
			<svg class="w-6 h-6" viewBox="0 0 16 16" fill="currentColor">
				<path
					d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
				/>
			</svg>
		</a>
	</div>
</aside>
