<script lang="ts">
	import {
		getConnection,
		getStatus,
		getError,
		isBusy,
		isConnected,
		connect,
		disconnect,
		getNextUIVersion
	} from '$lib/stores/connection.svelte.js';
	import { hasWebUSB, getBrowserRecommendation } from '$lib/adb/connection.js';
	import { toggleTheme, isDark } from '$lib/stores/theme.svelte.js';

	interface NavItem {
		id: string;
		label: string;
	}

	let {
		activeView = 'welcome',
		onNavigate
	}: { activeView: string; onNavigate: (view: string) => void } = $props();

	const webUsbSupported = hasWebUSB();

	const navItems: NavItem[] = [
		{ id: 'bios', label: 'BIOS' },
		{ id: 'roms', label: 'ROMs' },
		{ id: 'overlays', label: 'Overlays' },
		{ id: 'files', label: 'File Browser' }
	];
</script>

<aside class="w-60 bg-sidebar text-text h-screen flex flex-col shrink-0 border-r border-border">
	<!-- Header -->
	<div class="p-4 border-b border-border flex items-center justify-between">
		<h1 class="text-lg font-bold">NextUI Dashboard</h1>
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
		<div class="text-xs text-text-muted mb-2">Device</div>
		{#if isConnected()}
			<div class="text-sm text-green-400 truncate" title={getStatus()}>
				{getConnection()?.device.product ?? getConnection()?.device.serial ?? 'Connected'}
			</div>
			{#if getNextUIVersion()}
				<div class="text-xs text-text-muted mb-2">{getNextUIVersion()}</div>
			{/if}
			<button
				onclick={disconnect}
				disabled={isBusy()}
				class="w-full text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-1.5 rounded"
			>
				Disconnect
			</button>
		{:else}
			<div class="text-sm text-text-muted mb-2">
				{isBusy() ? 'Connecting...' : 'No device'}
			</div>
			{#if getError()}
				<div class="text-xs text-red-400 mb-2">{getError()}</div>
			{/if}
			<button
				onclick={connect}
				disabled={isBusy() || !webUsbSupported}
				class="w-full text-sm bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded"
			>
				{isBusy() ? 'Connecting...' : 'Connect'}
			</button>
			{#if !webUsbSupported}
				<div class="text-xs text-yellow-400 mt-2">WebUSB not available. Use Chrome or Edge.</div>
			{/if}
		{/if}
	</div>

	<!-- Navigation -->
	<nav class="flex-1 p-2">
		{#each navItems as item}
			<button
				onclick={() => onNavigate(item.id)}
				disabled={!isConnected()}
				class="w-full text-left px-3 py-2 rounded text-sm mb-0.5 transition-colors
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
</aside>
