<script lang="ts">
	import { isDeviceUpdateAvailable, dismissDeviceUpdate } from '$lib/stores/device-update.svelte.js';
</script>

{#if isDeviceUpdateAvailable()}
	<div class="shrink-0 flex items-center bg-blue-600 text-white px-4 py-2 text-sm">
		<span class="flex-1 text-center">
			New NextUI update available for your device. Open the Updater tool on your device to update or
			<a
				href="https://github.com/LoveRetro/NextUI/releases/latest"
				target="_blank"
				rel="noopener noreferrer"
				class="underline hover:text-blue-200"
			>
				view the release on GitHub.</a>
		</span>
		<button
			onclick={dismissDeviceUpdate}
			class="ml-4 shrink-0 hover:text-blue-200"
			aria-label="Dismiss"
		>
			✕
		</button>
	</div>
{/if}
