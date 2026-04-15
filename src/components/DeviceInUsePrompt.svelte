<script lang="ts">
	import { dismissDeviceInUsePrompt } from '$lib/stores/connection.svelte.js';
	import ActionButton from './ActionButton.svelte';
	import Modal from './Modal.svelte';

	const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
	const isMac = /Mac|iPhone|iPad/.test(ua);
	const terminalName = isMac ? 'Terminal' : 'Command Prompt';
	const command = 'adb kill-server';

	let copied = $state(false);

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(command);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard may be unavailable
		}
	}
</script>

<Modal onclose={dismissDeviceInUsePrompt}>
	<div class="p-6">
		<h3 class="text-lg font-bold text-text mb-3">Device In Use</h3>
		<p class="text-sm text-text-muted mb-4">
			Another program on your computer (likely a local <code>adb</code> server) is holding the USB
			connection to your device. The NextUI Dashboard can't connect until it's released.
		</p>
		<p class="text-sm text-text-muted mb-2">
			Open <strong class="text-text">{terminalName}</strong> on your computer and run:
		</p>
		<div class="flex items-center gap-2 mb-4">
			<code
				class="flex-1 bg-surface border border-border rounded px-3 py-2 text-sm font-mono text-text select-all"
			>{command}</code>
			<ActionButton onclick={copyCommand} variant="secondary">
				{copied ? 'Copied' : 'Copy'}
			</ActionButton>
		</div>
		<p class="text-sm text-text-muted mb-4">
			Then click Connect in the sidebar again.
		</p>
		<div class="flex justify-end">
			<ActionButton onclick={dismissDeviceInUsePrompt} variant="primary">OK</ActionButton>
		</div>
	</div>
</Modal>
