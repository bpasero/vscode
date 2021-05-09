/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { getFileNamesMessage, IConfirmation, IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { ByteSize, FileSystemProviderCapabilities, IFileService } from 'vs/platform/files/common/files';
import { Severity } from 'vs/platform/notification/common/notification';
import { IProgress, IProgressService, IProgressStep, ProgressLocation } from 'vs/platform/progress/common/progress';
import { IExplorerService } from 'vs/workbench/contrib/files/browser/files';
import { VIEW_ID } from 'vs/workbench/contrib/files/common/files';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { RunOnceWorker } from 'vs/base/common/async';
import { newWriteableBufferStream, VSBuffer } from 'vs/base/common/buffer';
import { basename, joinPath } from 'vs/base/common/resources';
import { ResourceFileEdit } from 'vs/editor/browser/services/bulkEditService';
import { ExplorerItem } from 'vs/workbench/contrib/files/common/explorerModel';
import { URI } from 'vs/base/common/uri';
import { IHostService } from 'vs/workbench/services/host/browser/host';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { extractResources } from 'vs/workbench/browser/dnd';
import { IWorkspaceEditingService } from 'vs/workbench/services/workspaces/common/workspaceEditing';

//#region Browser File Import (drag and drop, input element)

interface IBrowserImportOperation {
	startTime: number;
	progressScheduler: RunOnceWorker<IProgressStep>;

	filesTotal: number;
	filesUploaded: number;

	totalBytesUploaded: number;
}

interface IWebkitDataTransfer {
	items: IWebkitDataTransferItem[];
}

interface IWebkitDataTransferItem {
	webkitGetAsEntry(): IWebkitDataTransferItemEntry;
}

interface IWebkitDataTransferItemEntry {
	name: string | undefined;
	isFile: boolean;
	isDirectory: boolean;

	file(resolve: (file: File) => void, reject: () => void): void;
	createReader(): IWebkitDataTransferItemEntryReader;
}

interface IWebkitDataTransferItemEntryReader {
	readEntries(resolve: (file: IWebkitDataTransferItemEntry[]) => void, reject: () => void): void
}

export class BrowserFileImport {

	constructor(
		@IProgressService private readonly progressService: IProgressService,
		@IDialogService private readonly dialogService: IDialogService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService
	) {
	}

	import(target: ExplorerItem, source: DragEvent | FileList): Promise<void> {
		const cts = new CancellationTokenSource();

		// Indicate progress globally
		const uploadPromise = this.progressService.withProgress(
			{
				location: ProgressLocation.Window,
				delay: 800,
				cancellable: true,
				title: localize('uploadingFiles', "Uploading")
			},
			async progress => this.doImport(target, this.toTransfer(source), progress, cts.token),
			() => cts.dispose(true)
		);

		// Also indicate progress in the files view
		this.progressService.withProgress({ location: VIEW_ID, delay: 500 }, () => uploadPromise);

		return uploadPromise;
	}

	private toTransfer(source: DragEvent | FileList): IWebkitDataTransfer {
		if (source instanceof DragEvent) {
			return source.dataTransfer as unknown as IWebkitDataTransfer;
		}

		const transfer: IWebkitDataTransfer = { items: [] };

		for (const file of source) {
			transfer.items.push({
				webkitGetAsEntry: () => {
					return {
						name: file.name,
						isDirectory: false,
						isFile: true,
						createReader: () => { throw new Error('Unsupported for files'); },
						file: resolve => resolve(file)
					};
				}
			});
		}

		return transfer;
	}

	private async doImport(target: ExplorerItem, source: IWebkitDataTransfer, progress: IProgress<IProgressStep>, token: CancellationToken): Promise<void> {
		const items = source.items;

		// Somehow the items thing is being modified at random, maybe as a security
		// measure since this is a DND operation. As such, we copy the items into
		// an array we own as early as possible before using it.
		const entries: IWebkitDataTransferItemEntry[] = [];
		for (const item of items) {
			entries.push(item.webkitGetAsEntry());
		}

		const results: { isFile: boolean, resource: URI }[] = [];
		const operation: IBrowserImportOperation = {
			startTime: Date.now(),
			progressScheduler: new RunOnceWorker<IProgressStep>(steps => { progress.report(steps[steps.length - 1]); }, 1000),

			filesTotal: entries.length,
			filesUploaded: 0,

			totalBytesUploaded: 0
		};

		for (const entry of entries) {
			if (token.isCancellationRequested) {
				break;
			}

			// Confirm overwrite as needed
			if (target && entry.name && target.getChild(entry.name)) {
				const { confirmed } = await this.dialogService.confirm(getFileOverwriteConfirm(entry.name));
				if (!confirmed) {
					continue;
				}

				await this.explorerService.applyBulkEdit([new ResourceFileEdit(joinPath(target.resource, entry.name), undefined, { recursive: true })], {
					undoLabel: localize('overwrite', "Overwrite {0}", entry.name),
					progressLabel: localize('overwriting', "Overwriting {0}", entry.name),
				});

				if (token.isCancellationRequested) {
					break;
				}
			}

			// Upload entry
			const result = await this.doImportEntry(entry, target.resource, target, progress, operation, token);
			if (result) {
				results.push(result);
			}
		}

		operation.progressScheduler.dispose();

		// Open uploaded file in editor only if we upload just one
		const firstUploadedFile = results[0];
		if (!token.isCancellationRequested && firstUploadedFile?.isFile) {
			await this.editorService.openEditor({ resource: firstUploadedFile.resource, options: { pinned: true } });
		}
	}

	private async doImportEntry(entry: IWebkitDataTransferItemEntry, parentResource: URI, target: ExplorerItem | undefined, progress: IProgress<IProgressStep>, operation: IBrowserImportOperation, token: CancellationToken): Promise<{ isFile: boolean, resource: URI } | undefined> {
		if (token.isCancellationRequested || !entry.name || (!entry.isFile && !entry.isDirectory)) {
			return undefined;
		}

		// Report progress
		let fileBytesUploaded = 0;
		const reportProgress = (fileSize: number, bytesUploaded: number): void => {
			fileBytesUploaded += bytesUploaded;
			operation.totalBytesUploaded += bytesUploaded;

			const bytesUploadedPerSecond = operation.totalBytesUploaded / ((Date.now() - operation.startTime) / 1000);

			// Small file
			let message: string;
			if (fileSize < ByteSize.MB) {
				if (operation.filesTotal === 1) {
					message = `${entry.name}`;
				} else {
					message = localize('uploadProgressSmallMany', "{0} of {1} files ({2}/s)", operation.filesUploaded, operation.filesTotal, ByteSize.formatSize(bytesUploadedPerSecond));
				}
			}

			// Large file
			else {
				message = localize('uploadProgressLarge', "{0} ({1} of {2}, {3}/s)", entry.name, ByteSize.formatSize(fileBytesUploaded), ByteSize.formatSize(fileSize), ByteSize.formatSize(bytesUploadedPerSecond));
			}

			// Report progress but limit to update only once per second
			operation.progressScheduler.work({ message });
		};
		operation.filesUploaded++;
		reportProgress(0, 0);

		// Handle file upload
		const resource = joinPath(parentResource, entry.name);
		if (entry.isFile) {
			const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));

			if (token.isCancellationRequested) {
				return undefined;
			}

			// Chrome/Edge/Firefox support stream method, but only use it for
			// larger files to reduce the overhead of the streaming approach
			if (typeof file.stream === 'function' && file.size > ByteSize.MB) {
				await this.doImportFileBuffered(resource, file, reportProgress, token);
			}

			// Fallback to unbuffered upload for other browsers or small files
			else {
				await this.doImportFileUnbuffered(resource, file, reportProgress);
			}

			return { isFile: true, resource };
		}

		// Handle folder upload
		else {

			// Create target folder
			await this.fileService.createFolder(resource);

			if (token.isCancellationRequested) {
				return undefined;
			}

			// Recursive upload files in this directory
			const dirReader = entry.createReader();
			const childEntries: IWebkitDataTransferItemEntry[] = [];
			let done = false;
			do {
				const childEntriesChunk = await new Promise<IWebkitDataTransferItemEntry[]>((resolve, reject) => dirReader.readEntries(resolve, reject));
				if (childEntriesChunk.length > 0) {
					childEntries.push(...childEntriesChunk);
				} else {
					done = true; // an empty array is a signal that all entries have been read
				}
			} while (!done && !token.isCancellationRequested);

			// Update operation total based on new counts
			operation.filesTotal += childEntries.length;

			// Upload all entries as files to target
			const folderTarget = target && target.getChild(entry.name) || undefined;
			for (const childEntry of childEntries) {
				await this.doImportEntry(childEntry, resource, folderTarget, progress, operation, token);
			}

			return { isFile: false, resource };
		}
	}

	private async doImportFileBuffered(resource: URI, file: File, progressReporter: (fileSize: number, bytesUploaded: number) => void, token: CancellationToken): Promise<void> {
		const writeableStream = newWriteableBufferStream({
			// Set a highWaterMark to prevent the stream
			// for file upload to produce large buffers
			// in-memory
			highWaterMark: 10
		});
		const writeFilePromise = this.fileService.writeFile(resource, writeableStream);

		// Read the file in chunks using File.stream() web APIs
		try {
			const reader: ReadableStreamDefaultReader<Uint8Array> = file.stream().getReader();

			let res = await reader.read();
			while (!res.done) {
				if (token.isCancellationRequested) {
					return undefined;
				}

				// Write buffer into stream but make sure to wait
				// in case the highWaterMark is reached
				const buffer = VSBuffer.wrap(res.value);
				await writeableStream.write(buffer);

				if (token.isCancellationRequested) {
					return undefined;
				}

				// Report progress
				progressReporter(file.size, buffer.byteLength);

				res = await reader.read();
			}
			writeableStream.end(undefined);
		} catch (error) {
			writeableStream.error(error);
			writeableStream.end();
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		// Wait for file being written to target
		await writeFilePromise;
	}

	private doImportFileUnbuffered(resource: URI, file: File, progressReporter: (fileSize: number, bytesUploaded: number) => void): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = async event => {
				try {
					if (event.target?.result instanceof ArrayBuffer) {
						const buffer = VSBuffer.wrap(new Uint8Array(event.target.result));
						await this.fileService.writeFile(resource, buffer);

						// Report progress
						progressReporter(file.size, buffer.byteLength);
					} else {
						throw new Error('Could not read from dropped file.');
					}

					resolve();
				} catch (error) {
					reject(error);
				}
			};

			// Start reading the file to trigger `onload`
			reader.readAsArrayBuffer(file);
		});
	}
}

//#endregion

//#region Native File Import (drag and drop)

export class DesktopFileImport {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IHostService private readonly hostService: IHostService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IDialogService private readonly dialogService: IDialogService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IEditorService private readonly editorService: IEditorService,
		@IProgressService private readonly progressService: IProgressService
	) {
	}

	async import(target: ExplorerItem, source: DragEvent): Promise<void> {
		const cts = new CancellationTokenSource();

		// Indicate progress globally
		const importPromise = this.progressService.withProgress(
			{
				location: ProgressLocation.Window,
				delay: 800,
				cancellable: true,
				title: localize('copyingFiles', "Copying...")
			},
			async () => await this.doImport(target, source, cts.token),
			() => cts.dispose(true)
		);

		// Also indicate progress in the files view
		this.progressService.withProgress({ location: VIEW_ID, delay: 500 }, () => importPromise);

		return importPromise;
	}

	private async doImport(target: ExplorerItem, source: DragEvent, token: CancellationToken): Promise<void> {

		// Check for dropped external files to be folders
		const droppedResources = extractResources(source, true);
		const resolvedFiles = await this.fileService.resolveAll(droppedResources.map(droppedResource => ({ resource: droppedResource.resource })));

		if (token.isCancellationRequested) {
			return;
		}

		// Pass focus to window
		this.hostService.focus();

		// Handle folders by adding to workspace if we are in workspace context and if dropped on top
		const folders = resolvedFiles.filter(resolvedFile => resolvedFile.success && resolvedFile.stat && resolvedFile.stat.isDirectory).map(resolvedFile => ({ uri: resolvedFile.stat!.resource }));
		if (folders.length > 0 && target.isRoot) {
			const buttons = [
				folders.length > 1 ? localize('copyFolders', "&&Copy Folders") : localize('copyFolder', "&&Copy Folder"),
				localize('cancel', "Cancel")
			];
			const workspaceFolderSchemas = this.contextService.getWorkspace().folders.map(folder => folder.uri.scheme);
			let message = folders.length > 1 ? localize('copyfolders', "Are you sure to want to copy folders?") : localize('copyfolder', "Are you sure to want to copy '{0}'?", basename(folders[0].uri));
			if (folders.some(folder => workspaceFolderSchemas.indexOf(folder.uri.scheme) >= 0)) {

				// We only allow to add a folder to the workspace if there is already a workspace folder with that scheme
				buttons.unshift(folders.length > 1 ? localize('addFolders', "&&Add Folders to Workspace") : localize('addFolder', "&&Add Folder to Workspace"));
				message = folders.length > 1 ?
					localize('dropFolders', "Do you want to copy the folders or add the folders to the workspace?") :
					localize('dropFolder', "Do you want to copy '{0}' or add '{0}' as a folder to the workspace?", basename(folders[0].uri));
			}

			const { choice } = await this.dialogService.show(Severity.Info, message, buttons);
			if (choice === buttons.length - 3) {
				return this.workspaceEditingService.addFolders(folders);
			}

			if (choice === buttons.length - 2) {
				return this.addResources(target, droppedResources.map(res => res.resource), token);
			}

			return undefined;
		}

		// Handle dropped files (only support FileStat as target)
		else if (target instanceof ExplorerItem) {
			return this.addResources(target, droppedResources.map(res => res.resource), token);
		}
	}

	private async addResources(target: ExplorerItem, resources: URI[], token: CancellationToken): Promise<void> {
		if (resources && resources.length > 0) {

			// Resolve target to check for name collisions and ask user
			const targetStat = await this.fileService.resolve(target.resource);

			if (token.isCancellationRequested) {
				return;
			}

			// Check for name collisions
			const targetNames = new Set<string>();
			const caseSensitive = this.fileService.hasCapability(target.resource, FileSystemProviderCapabilities.PathCaseSensitive);
			if (targetStat.children) {
				targetStat.children.forEach(child => {
					targetNames.add(caseSensitive ? child.name : child.name.toLowerCase());
				});
			}

			const resourcesFiltered = (await Promise.all(resources.map(async resource => {
				if (targetNames.has(caseSensitive ? basename(resource) : basename(resource).toLowerCase())) {
					const confirmationResult = await this.dialogService.confirm(getFileOverwriteConfirm(basename(resource)));
					if (!confirmationResult.confirmed) {
						return undefined;
					}
				}

				return resource;
			}))).filter(resource => resource instanceof URI) as URI[];

			const resourceFileEdits = resourcesFiltered.map(resource => {
				const sourceFileName = basename(resource);
				const targetFile = joinPath(target.resource, sourceFileName);

				return new ResourceFileEdit(resource, targetFile, { overwrite: true, copy: true });
			});

			await this.explorerService.applyBulkEdit(resourceFileEdits, {
				undoLabel: resourcesFiltered.length === 1 ? localize('copyFile', "Copy {0}", basename(resourcesFiltered[0])) : localize('copynFile', "Copy {0} resources", resourcesFiltered.length),
				progressLabel: resourcesFiltered.length === 1 ? localize('copyingFile', "Copying {0}", basename(resourcesFiltered[0])) : localize('copyingnFile', "Copying {0} resources", resourcesFiltered.length)
			});

			// if we only add one file, just open it directly
			if (resourceFileEdits.length === 1) {
				const item = this.explorerService.findClosest(resourceFileEdits[0].newResource!);
				if (item && !item.isDirectory) {
					this.editorService.openEditor({ resource: item.resource, options: { pinned: true } });
				}
			}
		}
	}
}

//#engregion

//#region Helpers

export function getFileOverwriteConfirm(name: string): IConfirmation {
	return {
		message: localize('confirmOverwrite', "A file or folder with the name '{0}' already exists in the destination folder. Do you want to replace it?", name),
		detail: localize('irreversible', "This action is irreversible!"),
		primaryButton: localize({ key: 'replaceButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
		type: 'warning'
	};
}

export function getMultipleFilesOverwriteConfirm(files: URI[]): IConfirmation {
	if (files.length > 1) {
		return {
			message: localize('confirmManyOverwrites', "The following {0} files and/or folders already exist in the destination folder. Do you want to replace them?", files.length),
			detail: getFileNamesMessage(files) + '\n' + localize('irreversible', "This action is irreversible!"),
			primaryButton: localize({ key: 'replaceButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
			type: 'warning'
		};
	}

	return getFileOverwriteConfirm(basename(files[0]));
}

//#endregion
