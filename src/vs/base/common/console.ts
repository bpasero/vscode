/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from './uri.js';

/**
 * A console message that was logged in another process (for example the
 * extension host) and forwarded to be replayed locally.
 *
 * The sender serializes the arguments of the `console` call into
 * {@link IRemoteConsoleLog.arguments} and may append an {@link IStackArgument}
 * with the stack of the call site. Use {@link parse} to read the arguments back
 * and {@link log} to replay the message on the local `console`.
 */
export interface IRemoteConsoleLog {
	/** Discriminator of the message, typically `__$console`. */
	type: string;
	/** Name of the `console` method to call, such as `log`, `warn` or `error`. */
	severity: string;
	/** The JSON serialized array of arguments. The last element may be an {@link IStackArgument}. */
	arguments: string;
}

/**
 * A special trailing argument of an {@link IRemoteConsoleLog} that carries the stack trace of the call site.
 */
export interface IStackArgument {
	/** The stack trace of the call site, as produced by `new Error().stack`. */
	__$stack: string;
}

/** A source location parsed out of a stack trace. */
export interface IStackFrame {
	/** The file the frame points to. */
	uri: URI;
	/** The 1-based line number in {@link uri}. */
	line: number;
	/** The 1-based column number in {@link uri}. */
	column: number;
}

/** Returns whether `obj` looks like an {@link IRemoteConsoleLog}. */
export function isRemoteConsoleLog(obj: unknown): obj is IRemoteConsoleLog {
	const entry = obj as IRemoteConsoleLog;

	return entry && typeof entry.type === 'string' && typeof entry.severity === 'string';
}

/**
 * Deserializes the arguments of a remote console message and splits off the
 * stack trace, if present. Arguments that cannot be parsed are replaced with an
 * explanatory message.
 */
export function parse(entry: IRemoteConsoleLog): { args: any[]; stack?: string } {
	const args: any[] = [];
	let stack: string | undefined;

	// Parse Entry
	try {
		const parsedArguments: any[] = JSON.parse(entry.arguments);

		// Check for special stack entry as last entry
		const stackArgument = parsedArguments[parsedArguments.length - 1] as IStackArgument;
		if (stackArgument && stackArgument.__$stack) {
			parsedArguments.pop(); // stack is handled specially
			stack = stackArgument.__$stack;
		}

		args.push(...parsedArguments);
	} catch (error) {
		args.push('Unable to log remote console arguments', entry.arguments);
	}

	return { args, stack };
}

/**
 * Returns the source location of the top frame of the stack trace of a remote
 * console message, or of a raw stack string. Returns `undefined` if no location
 * could be parsed.
 */
export function getFirstFrame(entry: IRemoteConsoleLog): IStackFrame | undefined;
export function getFirstFrame(stack: string | undefined): IStackFrame | undefined;
export function getFirstFrame(arg0: IRemoteConsoleLog | string | undefined): IStackFrame | undefined {
	if (typeof arg0 !== 'string') {
		return getFirstFrame(parse(arg0!).stack);
	}

	// Parse a source information out of the stack if we have one. Format can be:
	// at vscode.commands.registerCommand (/Users/someone/Desktop/test-ts/out/src/extension.js:18:17)
	// or
	// at /Users/someone/Desktop/test-ts/out/src/extension.js:18:17
	// or
	// at c:\Users\someone\Desktop\end-js\extension.js:19:17
	// or
	// at e.$executeContributedCommand(c:\Users\someone\Desktop\end-js\extension.js:19:17)
	const stack = arg0;
	if (stack) {
		const topFrame = findFirstFrame(stack);

		// at [^\/]* => line starts with "at" followed by any character except '/' (to not capture unix paths too late)
		// (?:(?:[a-zA-Z]+:)|(?:[\/])|(?:\\\\) => windows drive letter OR unix root OR unc root
		// (?:.+) => simple pattern for the path, only works because of the line/col pattern after
		// :(?:\d+):(?:\d+) => :line:column data
		const matches = /at [^\/]*((?:(?:[a-zA-Z]+:)|(?:[\/])|(?:\\\\))(?:.+)):(\d+):(\d+)/.exec(topFrame || '');
		if (matches && matches.length === 4) {
			return {
				uri: URI.file(matches[1]),
				line: Number(matches[2]),
				column: Number(matches[3])
			};
		}
	}

	return undefined;
}

function findFirstFrame(stack: string | undefined): string | undefined {
	if (!stack) {
		return stack;
	}

	const newlineIndex = stack.indexOf('\n');
	if (newlineIndex === -1) {
		return stack;
	}

	return stack.substring(0, newlineIndex);
}

/**
 * Replays a remote console message on the local `console`, prefixed with
 * `label` and styled for the browser dev tools.
 *
 * @throws Error if `entry.severity` is not a known `console` method.
 */
export function log(entry: IRemoteConsoleLog, label: string): void {
	const { args, stack } = parse(entry);

	const isOneStringArg = typeof args[0] === 'string' && args.length === 1;

	let topFrame = findFirstFrame(stack);
	if (topFrame) {
		topFrame = `(${topFrame.trim()})`;
	}

	let consoleArgs: string[] = [];

	// First arg is a string
	if (typeof args[0] === 'string') {
		if (topFrame && isOneStringArg) {
			consoleArgs = [`%c[${label}] %c${args[0]} %c${topFrame}`, color('blue'), color(''), color('grey')];
		} else {
			consoleArgs = [`%c[${label}] %c${args[0]}`, color('blue'), color(''), ...args.slice(1)];
		}
	}

	// First arg is something else, just apply all
	else {
		consoleArgs = [`%c[${label}]%`, color('blue'), ...args];
	}

	// Stack: add to args unless already added
	if (topFrame && !isOneStringArg) {
		consoleArgs.push(topFrame);
	}

	// Log it
	// eslint-disable-next-line local/code-no-any-casts
	if (typeof (console as any)[entry.severity] !== 'function') {
		throw new Error('Unknown console method');
	}
	// eslint-disable-next-line local/code-no-any-casts
	(console as any)[entry.severity].apply(console, consoleArgs);
}

function color(color: string): string {
	return `color: ${color}`;
}
