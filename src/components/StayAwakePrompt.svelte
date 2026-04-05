<script lang="ts">
	import { respondToStayAwakePrompt, isStayAwakeBusy } from '$lib/stores/connection.svelte.js';
	import ActionButton from './ActionButton.svelte';
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
				<ActionButton
					onclick={() => respond(false)}
					disabled={isStayAwakeBusy()}
					variant="secondary"
				>
					No
				</ActionButton>
				<ActionButton
					onclick={() => respond(true)}
					disabled={isStayAwakeBusy()}
					variant="primary"
				>
					{isStayAwakeBusy() ? 'Enabling...' : 'Yes'}
				</ActionButton>
			</div>
		</div>
	</div>
</Modal>
