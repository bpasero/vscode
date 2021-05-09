/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { ByteSize, IFileService } from 'vs/platform/files/common/files';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IProgress, IProgressService, IProgressStep, ProgressLocation } from 'vs/platform/progress/common/progress';
import { getFileOverwriteConfirm, IExplorerService } from 'vs/workbench/contrib/files/browser/files';
import { VIEW_ID } from 'vs/workbench/contrib/files/common/files';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { RunOnceWorker } from 'vs/base/common/async';
import { newWriteableBufferStream, VSBuffer } from 'vs/base/common/buffer';
import { joinPath } from 'vs/base/common/resources';
import { ResourceFileEdit } from 'vs/editor/browser/services/bulkEditService';
import { ExplorerItem } from 'vs/workbench/contrib/files/common/explorerModel';
import { URI } from 'vs/base/common/uri';

//#region Web File Upload (drag and drop, input element)

interface IBrowserUploadOperation {
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

export class BrowserFileUpload {

	constructor(
		@IProgressService private readonly progressService: IProgressService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService
	) {
	}

	async upload(target: ExplorerItem, source: DragEvent | FileList): Promise<void> {
		const cts = new CancellationTokenSource();

		// Indicate progress globally
		const dropPromise = this.progressService.withProgress({
			location: ProgressLocation.Window,
			delay: 800,
			cancellable: true,
			title: localize('uploadingFiles', "Uploading")
		}, async progress => {
			try {
				await this.handleWebExternalDrop(target, this.toTransfer(source), progress, cts.token);
			} catch (error) {
				this.notificationService.warn(error);
			}
		}, () => cts.dispose(true));

		// Also indicate progress in the files view
		this.progressService.withProgress({ location: VIEW_ID, delay: 500 }, () => dropPromise);
	}

	private toTransfer(source: DragEvent | FileList): IWebkitDataTransfer {
		if (source instanceof DragEvent) {
			return source.dataTransfer as unknown as IWebkitDataTransfer;
		} else {
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
	}

	private async handleWebExternalDrop(target: ExplorerItem, source: IWebkitDataTransfer, progress: IProgress<IProgressStep>, token: CancellationToken): Promise<void> {
		const items = source.items;

		// Somehow the items thing is being modified at random, maybe as a security
		// measure since this is a DND operation. As such, we copy the items into
		// an array we own as early as possible before using it.
		const entries: IWebkitDataTransferItemEntry[] = [];
		for (const item of items) {
			entries.push(item.webkitGetAsEntry());
		}

		const results: { isFile: boolean, resource: URI }[] = [];
		const operation: IBrowserUploadOperation = {
			startTime: Date.now(),
			progressScheduler: new RunOnceWorker<IProgressStep>(steps => { progress.report(steps[steps.length - 1]); }, 1000),

			filesTotal: entries.length,
			filesUploaded: 0,

			totalBytesUploaded: 0
		};

		for (let entry of entries) {
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
			const result = await this.doUploadWebFileEntry(entry, target.resource, target, progress, operation, token);
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

	private async doUploadWebFileEntry(entry: IWebkitDataTransferItemEntry, parentResource: URI, target: ExplorerItem | undefined, progress: IProgress<IProgressStep>, operation: IBrowserUploadOperation, token: CancellationToken): Promise<{ isFile: boolean, resource: URI } | undefined> {
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
				await this.doUploadWebFileEntryBuffered(resource, file, reportProgress, token);
			}

			// Fallback to unbuffered upload for other browsers or small files
			else {
				await this.doUploadWebFileEntryUnbuffered(resource, file, reportProgress);
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
			for (let childEntry of childEntries) {
				await this.doUploadWebFileEntry(childEntry, resource, folderTarget, progress, operation, token);
			}

			return { isFile: false, resource };
		}
	}

	private async doUploadWebFileEntryBuffered(resource: URI, file: File, progressReporter: (fileSize: number, bytesUploaded: number) => void, token: CancellationToken): Promise<void> {
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

	private doUploadWebFileEntryUnbuffered(resource: URI, file: File, progressReporter: (fileSize: number, bytesUploaded: number) => void): Promise<void> {
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
