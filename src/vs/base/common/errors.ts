/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A listener that is told about unexpected errors, see {@link ErrorHandler.addListener}. */
export interface ErrorListenerCallback {
	(error: any): void;
}

/** Removes a listener that was added with {@link ErrorHandler.addListener}. */
export interface ErrorListenerUnbind {
	(): void;
}

// Avoid circular dependency on EventEmitter by implementing a subset of the interface.
/**
 * Central place that unexpected errors are reported to. By default an error is
 * rethrown asynchronously so that it surfaces as an uncaught error in the host
 * (for example in the dev tools console), and registered listeners are notified.
 */
export class ErrorHandler {
	private unexpectedErrorHandler: (e: any) => void;
	private listeners: ErrorListenerCallback[];

	constructor() {

		this.listeners = [];

		this.unexpectedErrorHandler = function (e: any) {
			setTimeout(() => {
				if (e.stack) {
					if (ErrorNoTelemetry.isErrorNoTelemetry(e)) {
						throw new ErrorNoTelemetry(e.message + '\n\n' + e.stack);
					}

					throw new Error(e.message + '\n\n' + e.stack);
				}

				throw e;
			}, 0);
		};
	}

	/**
	 * Adds a listener that is called for every error passed to {@link onUnexpectedError}.
	 * Returns a function that removes the listener again.
	 */
	addListener(listener: ErrorListenerCallback): ErrorListenerUnbind {
		this.listeners.push(listener);

		return () => {
			this._removeListener(listener);
		};
	}

	private emit(e: any): void {
		this.listeners.forEach((listener) => {
			listener(e);
		});
	}

	private _removeListener(listener: ErrorListenerCallback): void {
		this.listeners.splice(this.listeners.indexOf(listener), 1);
	}

	/** Replaces the function that is called for every unexpected error. */
	setUnexpectedErrorHandler(newUnexpectedErrorHandler: (e: any) => void): void {
		this.unexpectedErrorHandler = newUnexpectedErrorHandler;
	}

	/** Returns the function that is currently called for every unexpected error. */
	getUnexpectedErrorHandler(): (e: any) => void {
		return this.unexpectedErrorHandler;
	}

	/** Reports an unexpected error to the handler and to all listeners. */
	onUnexpectedError(e: any): void {
		this.unexpectedErrorHandler(e);
		this.emit(e);
	}

	// For external errors, we don't want the listeners to be called
	/**
	 * Reports an unexpected error that was caused outside of our code, for example
	 * by an extension. Only the handler is called, listeners are not notified.
	 */
	onUnexpectedExternalError(e: any): void {
		this.unexpectedErrorHandler(e);
	}
}

/** The global {@link ErrorHandler} instance. */
export const errorHandler = new ErrorHandler();

/** @skipMangle */
export function setUnexpectedErrorHandler(newUnexpectedErrorHandler: (e: any) => void): void {
	errorHandler.setUnexpectedErrorHandler(newUnexpectedErrorHandler);
}

/**
 * Returns if the error is a SIGPIPE error. SIGPIPE errors should generally be
 * logged at most once, to avoid a loop.
 *
 * @see https://github.com/microsoft/vscode-remote-release/issues/6481
 */
export function isSigPipeError(e: unknown): e is Error {
	if (!e || typeof e !== 'object') {
		return false;
	}

	const cast = e as Record<string, string | undefined>;
	return cast.code === 'EPIPE' && cast.syscall?.toUpperCase() === 'WRITE';
}

/**
 * This function should only be called with errors that indicate a bug in the product.
 * E.g. buggy extensions/invalid user-input/network issues should not be able to trigger this code path.
 * If they are, this indicates there is also a bug in the product.
*/
export function onBugIndicatingError(e: any): undefined {
	errorHandler.onUnexpectedError(e);
	return undefined;
}

/**
 * Reports an unexpected error to the global {@link errorHandler}.
 * Cancellation errors are ignored. Returns `undefined` so that it can be used
 * as the body of a `catch` callback.
 */
export function onUnexpectedError(e: any): undefined {
	// ignore errors from cancelled promises
	if (!isCancellationError(e)) {
		errorHandler.onUnexpectedError(e);
	}
	return undefined;
}

/**
 * Like {@link onUnexpectedError}, but for errors caused outside of our code,
 * for example by an extension. Listeners of the global handler are not notified.
 */
export function onUnexpectedExternalError(e: any): undefined {
	// ignore errors from cancelled promises
	if (!isCancellationError(e)) {
		errorHandler.onUnexpectedExternalError(e);
	}
	return undefined;
}

type ObjectWithCode = {
	readonly code: unknown;
};

function hasErrorCode(error: object): error is ObjectWithCode {
	return Object.hasOwn(error, 'code');
}

/**
 * Returns the `code` property of `error` as a string if it is a string or a
 * number, as set for example by Node.js system errors (`ENOENT`).
 */
export function getErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== 'object' || !hasErrorCode(error)) {
		return undefined;
	}
	const code = error.code;
	return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

/**
 * A plain object form of an {@link Error} that can be sent across process
 * boundaries. Create it with {@link transformErrorForSerialization} and turn it
 * back into an error with {@link transformErrorFromSerialization}.
 */
export interface SerializedError {
	readonly $isError: true;
	readonly name: string;
	readonly message: string;
	readonly stack: string;
	readonly noTelemetry: boolean;
	readonly code?: string;
	readonly cause?: SerializedError;
}

type ErrorWithCode = Error & {
	code: string | undefined;
};

/**
 * Converts an {@link Error} (including its `cause` chain) into a
 * {@link SerializedError}. Values that are not errors are returned unchanged.
 */
export function transformErrorForSerialization(error: Error): SerializedError;
export function transformErrorForSerialization(error: any): any;
export function transformErrorForSerialization(error: any): any {
	if (error instanceof Error) {
		const { name, message, cause } = error;
		// eslint-disable-next-line local/code-no-any-casts
		const stack: string = (<any>error).stacktrace || (<any>error).stack;
		return {
			$isError: true,
			name,
			message,
			stack,
			noTelemetry: ErrorNoTelemetry.isErrorNoTelemetry(error),
			cause: cause ? transformErrorForSerialization(cause) : undefined,
			code: (<ErrorWithCode>error).code
		};
	}

	// return as is
	return error;
}

/**
 * Recreates an {@link Error} from a {@link SerializedError}. Errors that were
 * marked as {@link ErrorNoTelemetry} are restored as such.
 */
export function transformErrorFromSerialization(data: SerializedError): Error {
	let error: Error;
	if (data.noTelemetry) {
		error = new ErrorNoTelemetry();
	} else {
		error = new Error();
		error.name = data.name;
	}
	error.message = data.message;
	error.stack = data.stack;
	if (data.code) {
		(<ErrorWithCode>error).code = data.code;
	}
	if (data.cause) {
		error.cause = transformErrorFromSerialization(data.cause);
	}
	return error;
}

// see https://github.com/v8/v8/wiki/Stack%20Trace%20API#basic-stack-traces
/** A call site of a V8 stack trace, as passed to `Error.prepareStackTrace`. */
export interface V8CallSite {
	getThis(): unknown;
	getTypeName(): string | null;
	getFunction(): Function | undefined;
	getFunctionName(): string | null;
	getMethodName(): string | null;
	getFileName(): string | null;
	getLineNumber(): number | null;
	getColumnNumber(): number | null;
	getEvalOrigin(): string | undefined;
	isToplevel(): boolean;
	isEval(): boolean;
	isNative(): boolean;
	isConstructor(): boolean;
	toString(): string;
}

/** The `name` and `message` of a {@link CancellationError}. */
export const canceledName = 'Canceled';

/**
 * Checks if the given error is a promise in canceled state
 */
export function isCancellationError(error: any): boolean {
	if (error instanceof CancellationError) {
		return true;
	}
	return error instanceof Error && error.name === canceledName && error.message === canceledName;
}

// !!!IMPORTANT!!!
// Do NOT change this class because it is also used as an API-type.
/**
 * The error that is used to reject an operation that was cancelled.
 * Use {@link isCancellationError} to check for it.
 */
export class CancellationError extends Error {
	constructor() {
		super(canceledName);
		this.name = this.message;
	}
}

/**
 * An error indicating that an operation cannot proceed until a pending
 * migration has completed. Use {@link PendingMigrationError.is} to check for it,
 * also for errors that were serialized and revived.
 */
export class PendingMigrationError extends Error {

	private static readonly _name = 'PendingMigrationError';

	static is(error: unknown): error is PendingMigrationError {
		return error instanceof PendingMigrationError || (error instanceof Error && error.name === PendingMigrationError._name);
	}

	constructor(message: string) {
		super(message);
		this.name = PendingMigrationError._name;
	}
}

/**
 * @deprecated use {@link CancellationError `new CancellationError()`} instead
 */
export function canceled(): Error {
	const error = new Error(canceledName);
	error.name = error.message;
	return error;
}

/** Creates an error for an invalid argument, optionally naming the argument. */
export function illegalArgument(name?: string): Error {
	if (name) {
		return new Error(`Illegal argument: ${name}`);
	} else {
		return new Error('Illegal argument');
	}
}

/** Creates an error for an operation that was called in an invalid state. */
export function illegalState(name?: string): Error {
	if (name) {
		return new Error(`Illegal state: ${name}`);
	} else {
		return new Error('Illegal state');
	}
}

/** A type error for an attempt to change a read only value. */
export class ReadonlyError extends TypeError {
	constructor(name?: string) {
		super(name ? `${name} is read-only and cannot be changed` : 'Cannot change read-only property');
	}
}

/**
 * Returns a human readable message for `err`: its `message`, else the first
 * line of its stack, else its string form.
 */
export function getErrorMessage(err: any): string {
	if (!err) {
		return 'Error';
	}

	if (err.message) {
		return err.message;
	}

	if (err.stack) {
		return err.stack.split('\n')[0];
	}

	return String(err);
}

/** Thrown by code that is not implemented yet. */
export class NotImplementedError extends Error {
	constructor(message?: string) {
		super('NotImplemented');
		if (message) {
			this.message = message;
		}
	}
}

/** Thrown when an operation is not supported, for example on the current platform. */
export class NotSupportedError extends Error {
	constructor(message?: string) {
		super('NotSupported');
		if (message) {
			this.message = message;
		}
	}
}

/** An error that is part of normal operation and does not indicate a bug. */
export class ExpectedError extends Error {
	readonly isExpected = true;
}

/**
 * Error that when thrown won't be logged in telemetry as an unhandled error.
 */
export class ErrorNoTelemetry extends Error {
	override readonly name: string;

	constructor(msg?: string) {
		super(msg);
		this.name = 'CodeExpectedError';
	}

	public static fromError(err: Error): ErrorNoTelemetry {
		if (err instanceof ErrorNoTelemetry) {
			return err;
		}

		const result = new ErrorNoTelemetry();
		result.message = err.message;
		result.stack = err.stack;
		return result;
	}

	public static isErrorNoTelemetry(err: Error): err is ErrorNoTelemetry {
		return err.name === 'CodeExpectedError';
	}
}

/**
 * This error indicates a bug.
 * Do not throw this for invalid user input.
 * Only catch this error to recover gracefully from bugs.
 */
export class BugIndicatingError extends Error {
	constructor(message?: string) {
		super(message || 'An unexpected bug occurred.');
		Object.setPrototypeOf(this, BugIndicatingError.prototype);

		// Because we know for sure only buggy code throws this,
		// we definitely want to break here and fix the bug.
		// debugger;
	}
}
