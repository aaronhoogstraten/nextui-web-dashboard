// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	const __APP_VERSION__: string;

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
		__nextui?: {
			readonly flags: Record<string, boolean>;
			enableFeature(id: string): void;
			disableFeature(id: string): void;
			resetFeatures(): void;
		};
	}

	// Drag-and-drop File System Entry API
	interface FileSystemEntry {
		readonly isFile: boolean;
		readonly isDirectory: boolean;
		readonly name: string;
		readonly fullPath: string;
	}

	interface FileSystemFileEntry extends FileSystemEntry {
		file(successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void): void;
	}

	interface FileSystemDirectoryEntry extends FileSystemEntry {
		createReader(): FileSystemDirectoryReader;
	}

	interface FileSystemDirectoryReader {
		readEntries(
			successCallback: (entries: FileSystemEntry[]) => void,
			errorCallback?: (error: DOMException) => void
		): void;
	}

	interface DataTransferItem {
		webkitGetAsEntry(): FileSystemEntry | null;
	}
}

export {};
