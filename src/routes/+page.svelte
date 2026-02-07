<script lang="ts">
	import {
		hasWebUSB,
		getBrowserRecommendation,
		connectWebUSB,
		disconnect,
		shell,
		listDirectory,
		getStorageInfo,
		verifyNextUIInstallation,
		runDiagnostics,
		type AdbConnection
	} from '$lib/adb/index.js';

	let connection: AdbConnection | null = $state(null);
	let status: string = $state('Disconnected');
	let error: string = $state('');
	let log: string[] = $state([]);
	let busy: boolean = $state(false);

	const webUsbSupported = hasWebUSB();
	const browserHint = getBrowserRecommendation();

	function addLog(message: string) {
		log = [...log, `[${new Date().toLocaleTimeString()}] ${message}`];
	}

	async function handleConnect() {
		error = '';
		busy = true;
		status = 'Connecting...';
		addLog('Requesting USB device...');

		try {
			connection = await connectWebUSB();
			status = `Connected: ${connection.device.serial}`;
			addLog(`Connected to ${connection.device.serial} (${connection.device.product ?? 'unknown'})`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			error = msg;
			status = 'Connection failed';
			addLog(`Error: ${msg}`);
		} finally {
			busy = false;
		}
	}

	async function handleDisconnect() {
		if (!connection) return;
		busy = true;
		try {
			await disconnect(connection);
			addLog('Disconnected');
		} catch (e) {
			addLog(`Disconnect error: ${e instanceof Error ? e.message : String(e)}`);
		}
		connection = null;
		status = 'Disconnected';
		busy = false;
	}

	async function handleDiagnostics() {
		if (!connection) return;
		busy = true;
		addLog('=== RUNNING DIAGNOSTICS ===');
		try {
			const results = await runDiagnostics(connection.adb);
			for (const r of results) {
				const icon = r.status === 'ok' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
				addLog(`  [${icon}] ${r.label}: ${r.detail}`);
			}
			addLog('=== DIAGNOSTICS COMPLETE ===');
		} catch (e) {
			addLog(`Diagnostics error: ${e instanceof Error ? e.message : String(e)}`);
		}
		busy = false;
	}

	async function runShellCommand(cmd: string) {
		if (!connection) return;
		busy = true;
		addLog(`$ ${cmd}`);
		try {
			const output = await shell(connection.adb, cmd);
			addLog(output.trim() || '(no output)');
		} catch (e) {
			addLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
		}
		busy = false;
	}

	async function testVerifyInstallation() {
		if (!connection) return;
		busy = true;
		addLog('Verifying NextUI installation...');
		try {
			const result = await verifyNextUIInstallation(connection.adb);
			if (result.ok) {
				addLog('NextUI installation verified!');
			} else {
				addLog(`Verification failed: ${result.error}`);
			}
		} catch (e) {
			addLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
		}
		busy = false;
	}

	async function testListDirectory(path: string) {
		if (!connection) return;
		busy = true;
		addLog(`Listing ${path} ...`);
		try {
			const entries = await listDirectory(connection.adb, path);
			addLog(`${entries.length} entries:`);
			for (const entry of entries.slice(0, 30)) {
				const type = entry.isDirectory ? 'DIR ' : 'FILE';
				addLog(`  ${type}  ${entry.name}  (${entry.size} bytes)`);
			}
			if (entries.length > 30) {
				addLog(`  ... and ${entries.length - 30} more`);
			}
		} catch (e) {
			addLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
		}
		busy = false;
	}

	async function testStorageInfo() {
		if (!connection) return;
		busy = true;
		addLog('Getting storage info...');
		try {
			const info = await getStorageInfo(connection.adb);
			if (info) {
				const toGB = (b: number) => (b / 1024 / 1024 / 1024).toFixed(2);
				addLog(`Storage: ${toGB(info.usedBytes)} GB used / ${toGB(info.totalBytes)} GB total (${toGB(info.availableBytes)} GB free)`);
			} else {
				addLog('Could not retrieve storage info (shell may not be supported on this device)');
			}
		} catch (e) {
			addLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
		}
		busy = false;
	}

	function copyLog() {
		navigator.clipboard.writeText(log.join('\n'));
		addLog('(Log copied to clipboard)');
	}
</script>

<div class="max-w-3xl mx-auto p-6">
	<h1 class="text-3xl font-bold mb-6">NextUI Web Dashboard</h1>

	{#if !webUsbSupported}
		<div class="bg-yellow-100 border border-yellow-400 text-yellow-800 rounded p-4 mb-4">
			<p class="font-semibold">WebUSB not available</p>
			<p>{browserHint || 'Please use Chrome or Edge.'}</p>
		</div>
	{/if}

	<!-- Connection -->
	<div class="mb-6">
		<p class="mb-2 text-sm text-gray-500">Status: <span class="font-mono">{status}</span></p>

		{#if error}
			<p class="text-red-600 text-sm mb-2">{error}</p>
		{/if}

		<div class="flex gap-2">
			{#if !connection}
				<button
					onclick={handleConnect}
					disabled={busy || !webUsbSupported}
					class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{busy ? 'Connecting...' : 'Connect Device'}
				</button>
			{:else}
				<button
					onclick={handleDisconnect}
					disabled={busy}
					class="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 disabled:opacity-50"
				>
					Disconnect
				</button>
			{/if}
		</div>
	</div>

	<!-- Test Commands -->
	{#if connection}
		<div class="mb-6 space-y-2">
			<h2 class="text-lg font-semibold">Diagnostics</h2>
			<div class="flex flex-wrap gap-2">
				<button onclick={handleDiagnostics} disabled={busy} class="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 disabled:opacity-50">
					{busy ? 'Running...' : 'Run Full Diagnostics'}
				</button>
			</div>

			<h2 class="text-lg font-semibold mt-4">Individual Tests</h2>
			<div class="flex flex-wrap gap-2">
				<button onclick={() => testVerifyInstallation()} disabled={busy} class="bg-gray-200 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50 text-sm">
					Verify NextUI
				</button>
				<button onclick={() => runShellCommand('echo hello')} disabled={busy} class="bg-gray-200 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50 text-sm">
					Shell: echo hello
				</button>
				<button onclick={() => runShellCommand('uname -a')} disabled={busy} class="bg-gray-200 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50 text-sm">
					Shell: uname -a
				</button>
				<button onclick={() => testStorageInfo()} disabled={busy} class="bg-gray-200 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50 text-sm">
					Storage Info
				</button>
				<button onclick={() => testListDirectory('/mnt/SDCARD')} disabled={busy} class="bg-gray-200 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50 text-sm">
					List /mnt/SDCARD
				</button>
				<button onclick={() => testListDirectory('/mnt/SDCARD/Bios')} disabled={busy} class="bg-gray-200 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50 text-sm">
					List Bios
				</button>
				<button onclick={() => testListDirectory('/mnt/SDCARD/Roms')} disabled={busy} class="bg-gray-200 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50 text-sm">
					List Roms
				</button>
			</div>
		</div>
	{/if}

	<!-- Log Output -->
	<div>
		<div class="flex items-center justify-between mb-1">
			<h2 class="text-lg font-semibold">Log</h2>
			<div class="flex gap-2">
				{#if log.length > 0}
					<button onclick={copyLog} class="text-xs text-blue-500 hover:text-blue-700">Copy to clipboard</button>
					<button onclick={() => (log = [])} class="text-xs text-gray-400 hover:text-gray-600">Clear</button>
				{/if}
			</div>
		</div>
		<pre class="bg-gray-900 text-green-400 text-xs p-4 rounded h-96 overflow-y-auto font-mono">{#if log.length === 0}Waiting for connection...{:else}{log.join('\n')}{/if}</pre>
	</div>
</div>
