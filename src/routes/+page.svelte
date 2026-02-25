<script lang="ts">
	import Sidebar from '../components/Sidebar.svelte';
	import BiosView from '../components/BiosView.svelte';
	import RomsView from '../components/RomsView.svelte';
	import FileBrowserView from '../components/FileBrowserView.svelte';
	import OverlaysView from '../components/OverlaysView.svelte';
	import CheatsView from '../components/CheatsView.svelte';
	import CollectionsView from '../components/CollectionsView.svelte';
	import LogsView from '../components/LogsView.svelte';
	import ScreenshotsView from '../components/ScreenshotsView.svelte';
	import ConsoleLog from '../components/ConsoleLog.svelte';
	import TransferProgress from '../components/TransferProgress.svelte';
	import StayAwakePrompt from '../components/StayAwakePrompt.svelte';
	import Modal from '../components/Modal.svelte';
	import {
		getConnection,
		isConnected,
		isStayAwakePromptShown,
		getStayAwakeError,
		dismissStayAwakeError
	} from '$lib/stores/connection.svelte.js';
	import { hasWebUSB } from '$lib/adb/connection.js';

	let activeView: string = $state('welcome');
	const connectedAdb = $derived(getConnection()?.adb ?? null);

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
					<h2 class="text-3xl font-bold mb-4">NextUI Dashboard</h2>
					<p class="text-text-muted mb-6">
						Connect your NextUI device via USB to get started<br />
						and then click the Connect button in the sidebar.
					</p>
					{#if !webUsbSupported}
						<div class="bg-surface border border-border rounded p-4 text-sm text-warning">
							WebUSB is not available in this browser.<br />
							Please use Chrome, Edge, or another Chromium browser.
						</div>
					{/if}
				</div>
			</div>
		{:else if activeView === 'bios'}
			<BiosView adb={connectedAdb!} />
		{:else if activeView === 'roms'}
			<RomsView adb={connectedAdb!} />
		{:else if activeView === 'overlays'}
			<OverlaysView adb={connectedAdb!} />
		{:else if activeView === 'cheats'}
			<CheatsView adb={connectedAdb!} />
		{:else if activeView === 'collections'}
			<CollectionsView adb={connectedAdb!} />
		{:else if activeView === 'screenshots'}
			<ScreenshotsView adb={connectedAdb!} />
		{:else if activeView === 'files'}
			<FileBrowserView adb={connectedAdb!} />
		{:else if activeView === 'logs'}
			<LogsView adb={connectedAdb!} />
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

	<TransferProgress />
	<ConsoleLog />
</div>

{#if isStayAwakePromptShown()}
	<StayAwakePrompt />
{/if}

{#if getStayAwakeError()}
	<Modal onclose={dismissStayAwakeError}>
		<div class="p-6">
			<h3 class="text-lg font-bold text-text mb-3">Keep device awake</h3>
			<p class="text-sm text-text whitespace-pre-line">{getStayAwakeError()}</p>
			<div class="mt-4 flex justify-end">
				<button
					onclick={dismissStayAwakeError}
					class="text-sm bg-surface hover:bg-surface-hover text-text px-3 py-1.5 rounded"
				>
					OK
				</button>
			</div>
		</div>
	</Modal>
{/if}
