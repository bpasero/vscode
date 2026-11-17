/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Range } from './range.js';

/** A point or box that a floating element, such as a context menu, is placed against. */
export interface IAnchor {
	x: number;
	y: number;
	width?: number;
	height?: number;
}

/** Horizontal edge of the anchor that the view aligns to. */
export const enum AnchorAlignment {
	LEFT, RIGHT
}

/** Whether the view is placed below or above the anchor. */
export const enum AnchorPosition {
	BELOW, ABOVE
}

/** The axis along which the view is placed next to the anchor first. */
export const enum AnchorAxisAlignment {
	VERTICAL, HORIZONTAL
}

interface IPosition {
	readonly top: number;
	readonly left: number;
}

interface ISize {
	readonly width: number;
	readonly height: number;
}

/** A rectangle described by its top left corner and its size. */
export interface IRect extends IPosition, ISize { }

/**
 * Preferred side of a one dimensional anchor. `Before` places the view after
 * the anchor's start (below or right of it), `After` places it before (above
 * or left of it).
 */
export const enum LayoutAnchorPosition {
	Before,
	After
}

/**
 * How the view relates to the anchor. `AVOID` places the view next to the
 * anchor without covering it, `ALIGN` lines up the view with an edge of the anchor.
 */
export enum LayoutAnchorMode {
	AVOID,
	ALIGN
}

/** A one dimensional anchor used by {@link layout}. */
export interface ILayoutAnchor {
	offset: number;
	size: number;
	mode?: LayoutAnchorMode; // default: AVOID
	position: LayoutAnchorPosition;
}

/**
 * The result of {@link layout}. `result` tells whether the view could be placed
 * on the preferred side (`ok`), had to move to the other side (`flipped`), or
 * fits on neither side and overlaps the anchor (`overlap`).
 */
export interface ILayoutResult {
	position: number;
	result: 'ok' | 'flipped' | 'overlap';
}

/**
 * Lays out a one dimensional view next to an anchor in a viewport.
 *
 * @returns The view offset within the viewport.
 */
export function layout(viewportSize: number, viewSize: number, anchor: ILayoutAnchor): ILayoutResult {
	const layoutAfterAnchorBoundary = anchor.mode === LayoutAnchorMode.ALIGN ? anchor.offset : anchor.offset + anchor.size;
	const layoutBeforeAnchorBoundary = anchor.mode === LayoutAnchorMode.ALIGN ? anchor.offset + anchor.size : anchor.offset;

	if (anchor.position === LayoutAnchorPosition.Before) {
		if (viewSize <= viewportSize - layoutAfterAnchorBoundary) {
			return { position: layoutAfterAnchorBoundary, result: 'ok' }; // happy case, lay it out after the anchor
		}

		if (viewSize <= layoutBeforeAnchorBoundary) {
			return { position: layoutBeforeAnchorBoundary - viewSize, result: 'flipped' }; // ok case, lay it out before the anchor
		}

		return { position: Math.max(viewportSize - viewSize, 0), result: 'overlap' }; // sad case, lay it over the anchor
	} else {
		if (viewSize <= layoutBeforeAnchorBoundary) {
			return { position: layoutBeforeAnchorBoundary - viewSize, result: 'ok' }; // happy case, lay it out before the anchor
		}

		if (viewSize <= viewportSize - layoutAfterAnchorBoundary && layoutBeforeAnchorBoundary < viewSize / 2) {
			return { position: layoutAfterAnchorBoundary, result: 'flipped' }; // ok case, lay it out after the anchor
		}

		return { position: 0, result: 'overlap' }; // sad case, lay it over the anchor
	}
}

interface ILayout2DOptions {
	readonly anchorAlignment?: AnchorAlignment; // default: left
	readonly anchorPosition?: AnchorPosition; // default: above
	readonly anchorAxisAlignment?: AnchorAxisAlignment; // default: vertical
}

/**
 * The result of {@link layout2d}: the view's distance from each edge of the
 * viewport, and the alignment and position that were actually used after any flips.
 */
export interface ILayout2DResult {
	top: number;
	left: number;
	bottom: number;
	right: number;
	anchorAlignment: AnchorAlignment;
	anchorPosition: AnchorPosition;
}

/**
 * Lays out a view next to an anchor in a two dimensional viewport, flipping the
 * view to the other side of the anchor on either axis when it does not fit.
 */
export function layout2d(viewport: IRect, view: ISize, anchor: IRect, options?: ILayout2DOptions): ILayout2DResult {
	let anchorAlignment = options?.anchorAlignment ?? AnchorAlignment.LEFT;
	let anchorPosition = options?.anchorPosition ?? AnchorPosition.BELOW;
	const anchorAxisAlignment = options?.anchorAxisAlignment ?? AnchorAxisAlignment.VERTICAL;

	let top: number;
	let left: number;

	if (anchorAxisAlignment === AnchorAxisAlignment.VERTICAL) {
		const verticalAnchor: ILayoutAnchor = { offset: anchor.top - viewport.top, size: anchor.height, position: anchorPosition === AnchorPosition.BELOW ? LayoutAnchorPosition.Before : LayoutAnchorPosition.After };
		const horizontalAnchor: ILayoutAnchor = { offset: anchor.left, size: anchor.width, position: anchorAlignment === AnchorAlignment.LEFT ? LayoutAnchorPosition.Before : LayoutAnchorPosition.After, mode: LayoutAnchorMode.ALIGN };

		const verticalLayoutResult = layout(viewport.height, view.height, verticalAnchor);
		top = verticalLayoutResult.position + viewport.top;

		if (verticalLayoutResult.result === 'flipped') {
			anchorPosition = anchorPosition === AnchorPosition.BELOW ? AnchorPosition.ABOVE : AnchorPosition.BELOW;
		}

		// if view intersects vertically with anchor, we must avoid the anchor
		if (Range.intersects({ start: top, end: top + view.height }, { start: verticalAnchor.offset, end: verticalAnchor.offset + verticalAnchor.size })) {
			horizontalAnchor.mode = LayoutAnchorMode.AVOID;
		}

		const horizontalLayoutResult = layout(viewport.width, view.width, horizontalAnchor);
		left = horizontalLayoutResult.position;

		if (horizontalLayoutResult.result === 'flipped') {
			anchorAlignment = anchorAlignment === AnchorAlignment.LEFT ? AnchorAlignment.RIGHT : AnchorAlignment.LEFT;
		}
	} else {
		const horizontalAnchor: ILayoutAnchor = { offset: anchor.left, size: anchor.width, position: anchorAlignment === AnchorAlignment.LEFT ? LayoutAnchorPosition.Before : LayoutAnchorPosition.After };
		const verticalAnchor: ILayoutAnchor = { offset: anchor.top, size: anchor.height, position: anchorPosition === AnchorPosition.BELOW ? LayoutAnchorPosition.Before : LayoutAnchorPosition.After, mode: LayoutAnchorMode.ALIGN };

		const horizontalLayoutResult = layout(viewport.width, view.width, horizontalAnchor);
		left = horizontalLayoutResult.position;

		if (horizontalLayoutResult.result === 'flipped') {
			anchorAlignment = anchorAlignment === AnchorAlignment.LEFT ? AnchorAlignment.RIGHT : AnchorAlignment.LEFT;
		}

		// if view intersects horizontally with anchor, we must avoid the anchor
		if (Range.intersects({ start: left, end: left + view.width }, { start: horizontalAnchor.offset, end: horizontalAnchor.offset + horizontalAnchor.size })) {
			verticalAnchor.mode = LayoutAnchorMode.AVOID;
		}

		const verticalLayoutResult = layout(viewport.height, view.height, verticalAnchor);
		top = verticalLayoutResult.position + viewport.top;

		if (verticalLayoutResult.result === 'flipped') {
			anchorPosition = anchorPosition === AnchorPosition.BELOW ? AnchorPosition.ABOVE : AnchorPosition.BELOW;
		}
	}

	const right = viewport.width - (left + view.width);
	const bottom = viewport.height - (top + view.height);

	return { top, left, bottom, right, anchorAlignment, anchorPosition };
}
