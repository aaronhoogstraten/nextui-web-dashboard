<script lang="ts" module>
	export const LARGE_ART_THRESHOLD = 2 * 1024 * 1024;
</script>

<script lang="ts">
	import Modal from './Modal.svelte';
	import ActionButton from './ActionButton.svelte';
	import { formatSize } from '$lib/utils.js';
	import { adbLog } from '$lib/stores/log.svelte.js';

	let file: File | null = $state(null);
	let resolver: ((data: Uint8Array<ArrayBuffer> | null) => void) | null = $state.raw(null);
	let resizing = $state(false);
	let resizeError: string = $state('');

	export async function check(f: File): Promise<Uint8Array<ArrayBuffer> | null> {
		if (f.size <= LARGE_ART_THRESHOLD) {
			return new Uint8Array(await f.arrayBuffer());
		}
		return new Promise((resolve) => {
			file = f;
			resizing = false;
			resizeError = '';
			resolver = resolve;
		});
	}

	function resolve(data: Uint8Array<ArrayBuffer> | null) {
		if (resolver) {
			resolver(data);
			file = null;
			resolver = null;
			resizing = false;
			resizeError = '';
		}
	}

	async function handleProceed() {
		const data = new Uint8Array(await file!.arrayBuffer());
		resolve(data);
	}

	async function handleAutoResize() {
		resizing = true;
		resizeError = '';
		try {
			const data = await resizeToThreshold(file!);
			resolve(data);
		} catch (e) {
			resizeError = e instanceof Error ? e.message : String(e);
			resizing = false;
		}
	}

	async function renderAtScale(bitmap: ImageBitmap, pct: number): Promise<Blob> {
		const w = Math.max(1, Math.round(bitmap.width * pct / 100));
		const h = Math.max(1, Math.round(bitmap.height * pct / 100));
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(bitmap, 0, 0, w, h);
		return canvas.convertToBlob({ type: 'image/png' });
	}

	async function resizeToThreshold(f: File): Promise<Uint8Array<ArrayBuffer>> {
		const bitmap = await createImageBitmap(f);
		try {
			// Scale down as PNG until under threshold
			const scales = [90, 80, 70, 60, 50, 40, 30, 25, 20, 15, 10, 7, 5, 3, 2, 1];
			adbLog.debug(`[LargeArtDialog] Original: ${bitmap.width}x${bitmap.height}, ${formatSize(f.size)}`);
			for (const pct of scales) {
				const blob = await renderAtScale(bitmap, pct);
				const w = Math.max(1, Math.round(bitmap.width * pct / 100));
				const h = Math.max(1, Math.round(bitmap.height * pct / 100));
				adbLog.debug(`[LargeArtDialog] ${pct}% → ${w}x${h} = ${formatSize(blob.size)}`);
				if (blob.size <= LARGE_ART_THRESHOLD) {
					adbLog.debug(`[LargeArtDialog] Success at ${pct}% scale`);
					return new Uint8Array(await blob.arrayBuffer());
				}
			}
			throw new Error('Could not reduce file below 2 MB even at 1% scale');
		} finally {
			bitmap.close();
		}
	}
</script>

{#if file}
	<Modal onclose={() => resolve(null)}>
		<div class="p-6">
			<h3 class="text-lg font-bold text-text mb-3">Large Art File Detected</h3>
			<div class="text-sm text-text mb-2">
				Detected large art file ({formatSize(file.size)}), it's recommended to use smaller files otherwise device performance could be affected.
			</div>
			<div class="font-mono text-xs text-text-muted mb-4 truncate" title={file.name}>{file.name}</div>

			{#if resizeError}
				<div class="text-sm text-warning mb-3">{resizeError}</div>
			{/if}

			<div class="grid grid-cols-3 gap-2">
				<ActionButton
					onclick={handleProceed}
					disabled={resizing}
					variant="secondary"
				>
					Proceed
				</ActionButton>
				<ActionButton
					onclick={() => resolve(null)}
					disabled={resizing}
					variant="secondary"
				>
					Cancel
				</ActionButton>
				<ActionButton
					onclick={handleAutoResize}
					disabled={resizing}
					variant="primary"
				>
					{resizing ? 'Resizing...' : 'Auto Resize'}
				</ActionButton>
			</div>
		</div>
	</Modal>
{/if}
