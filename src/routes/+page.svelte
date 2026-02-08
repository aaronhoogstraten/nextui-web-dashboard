<script lang="ts">
	import Sidebar from '../components/Sidebar.svelte';
	import BiosView from '../components/BiosView.svelte';
	import RomsView from '../components/RomsView.svelte';
	import FileBrowserView from '../components/FileBrowserView.svelte';
	import ConsoleLog from '../components/ConsoleLog.svelte';
	import { getConnection, isConnected } from '$lib/stores/connection.svelte.js';
	import { hasWebUSB } from '$lib/adb/connection.js';

	let activeView: string = $state('welcome');

	function handleNavigate(view: string) {
		activeView = view;
	}

	const webUsbSupported = hasWebUSB();
</script>

<Sidebar {activeView} onNavigate={handleNavigate} />

<div class="flex-1 flex flex-col overflow-hidden">
	<main class="flex-1 overflow-y-auto bg-bg text-text">
		{#if !isConnected()}
			<!-- Welcome / Connect prompt -->
			<div class="flex items-center justify-center h-full">
				<div class="text-center max-w-md">
					<h2 class="text-3xl font-bold mb-4">NextUI Web Dashboard</h2>
					<p class="text-text-muted mb-6">
						Connect your NextUI device via USB to get started. Use the Connect button in the sidebar.
					</p>
					{#if !webUsbSupported}
						<div class="bg-surface border border-border rounded p-4 text-sm text-yellow-500">
							WebUSB is not available in this browser. Please use Chrome or Edge.
						</div>
					{/if}
				</div>
			</div>
		{:else if activeView === 'bios'}
			<BiosView adb={getConnection()!.adb} />
		{:else if activeView === 'roms'}
			<RomsView adb={getConnection()!.adb} />
		{:else if activeView === 'files'}
			<FileBrowserView adb={getConnection()!.adb} />
		{:else}
			<!-- Default connected state -->
			<div class="flex items-center justify-center h-full">
				<div class="text-center text-text-muted">
					<p class="text-lg">Device connected</p>
					<p class="text-sm mt-1">Select a tool from the sidebar</p>
				</div>
			</div>
		{/if}
	</main>

	<ConsoleLog />
</div>
