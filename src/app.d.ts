// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	// File System Access API (not yet in standard lib)
	interface FileSystemDirectoryHandle {
		values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
		getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandle>;
		getFileHandle(name: string): Promise<FileSystemFileHandle>;
		readonly kind: 'directory';
		readonly name: string;
	}

	interface FileSystemFileHandle {
		getFile(): Promise<File>;
		readonly kind: 'file';
		readonly name: string;
	}

	interface Window {
		showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
	}
}

export {};
