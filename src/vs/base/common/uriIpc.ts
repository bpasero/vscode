/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from './buffer.js';
import { MarshalledObject } from './marshalling.js';
import { MarshalledId } from './marshallingIds.js';
import { URI, UriComponents } from './uri.js';

/**
 * Rewrites URIs as they cross a process boundary, for example to map between
 * the URIs of a remote machine and the URIs seen by the local renderer.
 * "Incoming" URIs are received from the other side, "outgoing" URIs are sent to it.
 */
export interface IURITransformer {
	transformIncoming(uri: UriComponents): UriComponents;
	transformOutgoing(uri: UriComponents): UriComponents;
	transformOutgoingURI(uri: URI): URI;
	transformOutgoingScheme(scheme: string): string;
}

/** The raw components of a URI, as seen by an {@link IRawURITransformer}. */
export interface UriParts {
	scheme: string;
	authority?: string;
	path?: string;
	query?: string;
	fragment?: string;
}

/**
 * A low level URI transformer that operates on plain {@link UriParts}.
 * Wrap it in a {@link URITransformer} to get an {@link IURITransformer}.
 */
export interface IRawURITransformer {
	transformIncoming(uri: UriParts): UriParts;
	transformOutgoing(uri: UriParts): UriParts;
	transformOutgoingScheme(scheme: string): string;
}

function toJSON(uri: URI): UriComponents {
	return uri.toJSON();
}

/**
 * Adapts an {@link IRawURITransformer} to the {@link IURITransformer} interface.
 * Returns the input unchanged when the raw transformer did not change it.
 */
export class URITransformer implements IURITransformer {

	private readonly _uriTransformer: IRawURITransformer;

	constructor(uriTransformer: IRawURITransformer) {
		this._uriTransformer = uriTransformer;
	}

	public transformIncoming(uri: UriComponents): UriComponents {
		const result = this._uriTransformer.transformIncoming(uri);
		return (result === uri ? uri : toJSON(URI.from(result)));
	}

	public transformOutgoing(uri: UriComponents): UriComponents {
		const result = this._uriTransformer.transformOutgoing(uri);
		return (result === uri ? uri : toJSON(URI.from(result)));
	}

	public transformOutgoingURI(uri: URI): URI {
		const result = this._uriTransformer.transformOutgoing(uri);
		return (result === uri ? uri : URI.from(result));
	}

	public transformOutgoingScheme(scheme: string): string {
		return this._uriTransformer.transformOutgoingScheme(scheme);
	}
}

/** A transformer that returns every URI and scheme unchanged. */
export const DefaultURITransformer: IURITransformer = new class {
	transformIncoming(uri: UriComponents) {
		return uri;
	}

	transformOutgoing(uri: UriComponents): UriComponents {
		return uri;
	}

	transformOutgoingURI(uri: URI): URI {
		return uri;
	}

	transformOutgoingScheme(scheme: string): string {
		return scheme;
	}
};

function _transformOutgoingURIs(obj: any, transformer: IURITransformer, depth: number): any {

	if (!obj || depth > 200) {
		return null;
	}

	if (typeof obj === 'object') {
		if (obj instanceof URI) {
			return transformer.transformOutgoing(obj);
		}

		// walk object (or array)
		for (const key in obj) {
			if (Object.hasOwnProperty.call(obj, key)) {
				const r = _transformOutgoingURIs(obj[key], transformer, depth + 1);
				if (r !== null) {
					obj[key] = r;
				}
			}
		}
	}

	return null;
}

/**
 * Walks `obj` (objects and arrays, up to a depth of 200) and replaces every
 * {@link URI} instance in place with its outgoing transformed form.
 *
 * @returns `obj` itself, or the transformed value if `obj` is a URI.
 */
export function transformOutgoingURIs<T>(obj: T, transformer: IURITransformer): T {
	const result = _transformOutgoingURIs(obj, transformer, 0);
	if (result === null) {
		// no change
		return obj;
	}
	return result;
}


function _transformIncomingURIs(obj: any, transformer: IURITransformer, revive: boolean, depth: number): any {

	if (!obj || depth > 200) {
		return null;
	}

	if (typeof obj === 'object') {

		if ((<MarshalledObject>obj).$mid === MarshalledId.Uri) {
			return revive ? URI.revive(transformer.transformIncoming(obj)) : transformer.transformIncoming(obj);
		}

		if (obj instanceof VSBuffer) {
			return null;
		}

		// walk object (or array)
		for (const key in obj) {
			if (Object.hasOwnProperty.call(obj, key)) {
				const r = _transformIncomingURIs(obj[key], transformer, revive, depth + 1);
				if (r !== null) {
					obj[key] = r;
				}
			}
		}
	}

	return null;
}

/**
 * Walks `obj` (objects and arrays, up to a depth of 200) and replaces every
 * marshalled URI in place with its incoming transformed form. The URIs are left
 * as plain {@link UriComponents}; use {@link transformAndReviveIncomingURIs} to
 * get {@link URI} instances.
 */
export function transformIncomingURIs<T>(obj: T, transformer: IURITransformer): T {
	const result = _transformIncomingURIs(obj, transformer, false, 0);
	if (result === null) {
		// no change
		return obj;
	}
	return result;
}

/**
 * Like {@link transformIncomingURIs}, but also revives each transformed URI
 * into a {@link URI} instance.
 */
export function transformAndReviveIncomingURIs<T>(obj: T, transformer: IURITransformer): T {
	const result = _transformIncomingURIs(obj, transformer, true, 0);
	if (result === null) {
		// no change
		return obj;
	}
	return result;
}
