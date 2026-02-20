<script lang="ts">
	import { respondToStayAwakePrompt, isStayAwakeBusy } from '$lib/stores/connection.svelte.js';
	import Modal from './Modal.svelte';

	let dontAskAgain = $state(false);

	function respond(yes: boolean) {
		if (yes) {
			respondToStayAwakePrompt(dontAskAgain ? 'yes-always' : 'yes');
		} else {
			respondToStayAwakePrompt(dontAskAgain ? 'never' : 'no');
		}
	}
</script>

<Modal onclose={() => respond(false)}>
	<div class="p-6">
		<h3 class="text-lg font-bold text-text mb-3">Keep Device Awake?</h3>
		<p class="text-sm text-text-muted mb-4">
			This will prevent the device from going to sleep and disconnecting while any file operations are in progress.<br />
			<br />
			Selecting 'Yes' will install and launch the
			<a
				href="https://github.com/josegonzalez/minui-developer-pak"
				target="_blank"
				rel="noopener noreferrer"
				class="text-accent hover:underline"
			>Developer.pak</a>
			on your device.
		</p>
		<div class="flex items-center justify-between">
			<label class="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
				<input type="checkbox" bind:checked={dontAskAgain} class="accent-accent" />
				Don't ask again
			</label>
			<div class="flex items-center gap-2">
				<button
					onclick={() => respond(false)}
					disabled={isStayAwakeBusy()}
					class="text-sm bg-surface hover:bg-surface-hover text-text px-3 py-1.5 rounded disabled:opacity-50"
				>
					No
				</button>
				<button
					onclick={() => respond(true)}
					disabled={isStayAwakeBusy()}
					class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
				>
					{isStayAwakeBusy() ? 'Enabling...' : 'Yes'}
				</button>
			</div>
		</div>
	</div>
</Modal>
