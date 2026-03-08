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
		getPlatform,
		isStayAwakeActive,
		isStayAwakeBusy,
		toggleStayAwake,
		canStayAwake
	} from '$lib/stores/connection.svelte.js';
	import { hasWebUSB, getBrowserRecommendation } from '$lib/adb/connection.js';
	import { toggleTheme, isDark, getTheme } from '$lib/stores/theme.svelte.js';
	import { isFeatureEnabled } from '$lib/stores/features.svelte.js';
	import { base } from '$app/paths';

	interface NavItem {
		id: string;
		label: string;
		icon: string;
	}

	let {
		activeView = 'welcome',
		onNavigate
	}: { activeView: string; onNavigate: (view: string) => void } = $props();

	let collapsed = $state(false);

	// Auto-expand when device disconnects so Connect button is always visible
	$effect(() => {
		if (!isConnected()) {
			collapsed = false;
		}
	});

	const webUsbSupported = hasWebUSB();
	const deviceLabel = $derived.by(() => {
		const conn = getConnection();
		const name = conn?.device.product ?? conn?.device.serial ?? 'Connected';
		const p = getPlatform();
		return p ? `${name} (${p})` : name;
	});

	const allNavItems: NavItem[] = [
		{ id: 'roms', label: 'ROMs', icon: '🎮' },
		{ id: 'bios', label: 'BIOS', icon: '⚙' },
		{ id: 'overlays', label: 'Overlays', icon: '🎨' },
		{ id: 'cheats', label: 'Cheats', icon: '🔑' },
		{ id: 'collections', label: 'Collections', icon: '⭐' },
		{ id: 'screenshots', label: 'Screenshots', icon: '📷' },
		{ id: 'files', label: 'File Browser', icon: '📁' },
		{ id: 'logs', label: 'Log Viewer', icon: '📋' }
	];
	const navItems = $derived(allNavItems.filter(item => isFeatureEnabled(item.id)));
</script>

{#snippet themeIcon()}
	{#if getTheme() === 'dark'}
		<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
			<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
		</svg>
	{:else if getTheme() === 'light'}
		<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
		</svg>
	{:else}
		<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />
		</svg>
	{/if}
{/snippet}

<aside
	class="bg-sidebar text-text h-screen flex flex-col shrink-0 border-r border-border shadow-[2px_0_12px_rgba(0,0,0,0.3)] z-10 transition-[width] duration-150 overflow-hidden {collapsed ? 'w-14' : 'w-60'}"
>
	<!-- Header -->
	<div class="p-4 border-b border-border flex items-center {collapsed ? 'flex-col gap-2 justify-center' : 'justify-between'}">
		{#if !collapsed}
			<h1 class="text-xl font-bold whitespace-nowrap">NextUI Dashboard</h1>
		{/if}
		{#if collapsed && isConnected()}
			<button
				onclick={disconnect}
				disabled={isBusy()}
				class="text-red-400 hover:text-red-300 disabled:opacity-50 p-1 rounded"
				title="Disconnect"
			>
				⏏
			</button>
		{/if}
		<button
			onclick={toggleTheme}
			class="text-text-muted hover:text-text p-1 rounded"
			title={getTheme() === 'dark'
				? 'Current: dark\nSwitch to: light'
				: getTheme() === 'light'
					? 'Current: light\nSwitch to: system'
					: 'Current: system\nSwitch to: dark'}
		>
			{@render themeIcon()}
		</button>
	</div>

	<!-- Connection -->
	{#if !collapsed}
		<div class="p-4 border-b border-border">
			<div class="text-sm text-text-muted mb-2">Device</div>
			{#if isConnected()}
				<div class="text-base text-success truncate" title={getStatus()}>
					{deviceLabel}
				</div>
				{#if getNextUIVersion()}
					<div class="text-sm text-text-muted mb-2">{getNextUIVersion()}</div>
				{/if}
				{#if canStayAwake()}
					<label
						class="flex items-center justify-between text-sm text-text-muted mb-2 cursor-pointer"
						title="Keep the device screen awake while connected"
					>
						<span>Keep device awake</span>
						<button
							onclick={toggleStayAwake}
							disabled={isStayAwakeBusy()}
							class="relative w-9 h-5 rounded-full transition-colors disabled:opacity-50 {isStayAwakeActive()
								? 'bg-accent'
								: 'bg-surface-hover'}"
							role="switch"
							aria-checked={isStayAwakeActive()}
							aria-label="Toggle keeping the device awake"
						>
							<span
								class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform {isStayAwakeActive()
									? 'translate-x-4'
									: ''}"
							></span>
						</button>
					</label>
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
	{/if}

	<!-- Navigation -->
	<nav class="flex-1 p-2">
		{#each navItems as item}
			<button
				onclick={() => onNavigate(item.id)}
				disabled={!isConnected()}
				class="w-full px-3 py-2 rounded text-base mb-0.5 transition-colors flex items-center gap-2 whitespace-nowrap
					{collapsed ? 'justify-center' : 'text-left'}
					{activeView === item.id
					? 'bg-surface-hover text-text'
					: isConnected()
						? 'text-text-muted hover:bg-surface hover:text-text'
						: 'text-text-muted opacity-50 cursor-not-allowed'}"
				title={collapsed ? item.label : undefined}
			>
				{#if collapsed}
					<span>{item.icon}</span>
				{:else}
					<span>{item.label}</span>
				{/if}
			</button>
		{/each}
	</nav>

	<!-- Collapse toggle -->
	<div class="py-2 flex {collapsed ? 'px-2 justify-center' : 'px-5'}">
		<button
			onclick={() => (collapsed = !collapsed)}
			disabled={!isConnected()}
			class="text-text-muted hover:text-text rounded disabled:opacity-30 disabled:cursor-not-allowed {collapsed ? 'p-1 text-2xl leading-none' : 'text-sm'}"
			title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
		>
			{#if collapsed}
				»
			{:else}
				<span class="flex items-center gap-1">« Hide Sidebar</span>
			{/if}
		</button>
	</div>

	<!-- External links -->
	<div class="p-3 border-t border-border flex items-center {collapsed ? 'flex-col gap-2 justify-center' : 'gap-3'}">
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
