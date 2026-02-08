<script lang="ts">
	import {
		getConnection,
		getStatus,
		getError,
		isBusy,
		isConnected,
		connect,
		disconnect
	} from '$lib/stores/connection.svelte.js';
	import { hasWebUSB, getBrowserRecommendation } from '$lib/adb/connection.js';

	interface NavItem {
		id: string;
		label: string;
	}

	let { activeView = 'welcome', onNavigate }: { activeView: string; onNavigate: (view: string) => void } = $props();

	const webUsbSupported = hasWebUSB();

	const navItems: NavItem[] = [
		{ id: 'bios', label: 'BIOS' },
		{ id: 'roms', label: 'ROMs' },
		{ id: 'files', label: 'File Browser' }
	];
</script>

<aside class="w-60 bg-gray-900 text-white h-screen flex flex-col shrink-0">
	<!-- Header -->
	<div class="p-4 border-b border-gray-700">
		<h1 class="text-lg font-bold">NextUI Dashboard</h1>
	</div>

	<!-- Connection -->
	<div class="p-4 border-b border-gray-700">
		<div class="text-xs text-gray-400 mb-2">Device</div>
		{#if isConnected()}
			<div class="text-sm text-green-400 mb-2 truncate" title={getStatus()}>
				{getConnection()?.device.product ?? getConnection()?.device.serial ?? 'Connected'}
			</div>
			<button
				onclick={disconnect}
				disabled={isBusy()}
				class="w-full text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 px-3 py-1.5 rounded"
			>
				Disconnect
			</button>
		{:else}
			<div class="text-sm text-gray-500 mb-2">
				{isBusy() ? 'Connecting...' : 'No device'}
			</div>
			{#if getError()}
				<div class="text-xs text-red-400 mb-2">{getError()}</div>
			{/if}
			<button
				onclick={connect}
				disabled={isBusy() || !webUsbSupported}
				class="w-full text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 rounded"
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
						? 'bg-gray-700 text-white'
						: isConnected()
							? 'text-gray-300 hover:bg-gray-800 hover:text-white'
							: 'text-gray-600 cursor-not-allowed'}"
			>
				{item.label}
			</button>
		{/each}
	</nav>
</aside>
