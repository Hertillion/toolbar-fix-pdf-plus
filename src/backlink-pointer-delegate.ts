import { Component } from 'obsidian';

import { isTargetHTMLElement } from 'utils';


interface HitRect {
    el: HTMLElement;
    /** Coordinates relative to the top-left corner of the backlink highlight layer. */
    left: number;
    top: number;
    right: number;
    bottom: number;
}


/**
 * Backlink highlights are absolutely-positioned `<div>`s stacked on top of PDF.js's text layer.
 * They used to have `pointer-events: auto` so that they could receive the `mouseover` (hover
 * preview & backlink pane highlighting), `dblclick` (open backlink) and `contextmenu` events.
 *
 * The problem is that `pointer-events` is all-or-nothing. By taking part in hit-testing, the
 * highlights also swallow `mousedown`, which is the event the browser uses to anchor a text
 * selection. A highlight `<div>` contains no text node, so a mousedown on it yields no caret
 * position and dragging over already-highlighted text selects nothing or jumps around.
 * The problem is even worse than it looks because the highlights are painted with a padding
 * and a negative margin of the same size, which makes their hit box slightly larger than the
 * text they cover.
 *
 * None of the three events above have anything to do with text selection, so the highlights are
 * now click-through (`pointer-events: none`, see `styles.css`) and this class re-creates those
 * events instead: it listens on the page element, hit-tests the pointer position against the
 * highlight rectangles, and re-dispatches the event on the highlight under the cursor.
 * Text selection is left entirely to the text layer, exactly as if no highlight were there.
 */
export class BacklinkHighlightPointerDelegate extends Component {
    private hoveredEl: HTMLElement | null = null;
    private hitRects: HitRect[] | null = null;
    private hitRectsLayerSize: { width: number, height: number } | null = null;
    private pendingMouseMove: MouseEvent | null = null;
    private frameId: number | null = null;

    constructor(public pageEl: HTMLElement, public layerEl: HTMLElement) {
        super();
    }

    onload() {
        this.registerDomEvent(this.pageEl, 'mousemove', (evt) => this.queueHoverUpdate(evt));
        this.registerDomEvent(this.pageEl, 'mouseleave', (evt) => this.setHovered(null, evt));
        this.registerDomEvent(this.pageEl, 'dblclick', (evt) => this.redispatch(evt));
        this.registerDomEvent(this.pageEl, 'contextmenu', (evt) => this.redispatch(evt));
    }

    onunload() {
        if (this.frameId !== null) {
            this.pageEl.win.cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        this.pendingMouseMove = null;
        this.hoveredEl = null;
        this.hitRects = null;
        this.hitRectsLayerSize = null;
    }

    /** Force the hit rectangles to be recomputed, e.g. after highlights have been added or removed. */
    invalidateHitRects() {
        this.hitRects = null;
        this.hitRectsLayerSize = null;
    }

    /**
     * `mousemove` fires far more often than once per frame, and each hover update reads layout,
     * so coalesce them into a single update per animation frame.
     */
    private queueHoverUpdate(evt: MouseEvent) {
        // Don't begin a hover interaction while a button is held down: the user is dragging
        // (most likely selecting text), and popping up a hover preview mid-drag steals the pointer.
        if (evt.buttons !== 0) {
            this.setHovered(null, evt);
            return;
        }

        this.pendingMouseMove = evt;

        if (this.frameId !== null) return;
        this.frameId = this.pageEl.win.requestAnimationFrame(() => {
            this.frameId = null;
            const pending = this.pendingMouseMove;
            this.pendingMouseMove = null;
            if (pending) this.setHovered(this.hitTest(pending), pending);
        });
    }

    private setHovered(el: HTMLElement | null, source: MouseEvent) {
        if (el === this.hoveredEl) return;

        const prevEl = this.hoveredEl;
        this.hoveredEl = el;

        // Dispatch the `mouseout` first so that the previous highlight's cleanup runs before
        // the new one's `mouseover`, which is the order the native events would arrive in.
        if (prevEl) this.dispatch(prevEl, 'mouseout', source, el);
        if (el) this.dispatch(el, 'mouseover', source, prevEl);
    }

    private redispatch(evt: MouseEvent) {
        const el = this.hitTest(evt);
        if (!el) return;

        const dispatched = this.dispatch(el, evt.type, evt);
        // The handlers signal "I've handled this" by calling `preventDefault` (this is how
        // `onBacklinkVisualizerContextMenu` stops the generic PDF context menu from also
        // showing up), so the original event has to be marked as handled as well.
        if (dispatched.defaultPrevented) evt.preventDefault();
    }

    private dispatch(el: HTMLElement, type: string, source: MouseEvent, relatedTarget: EventTarget | null = null) {
        const win = source.win as Window & typeof globalThis;
        // `bubbles: false` matters: this event is dispatched from a listener registered on an
        // ancestor of `el`, so a bubbling event would re-enter this delegate forever.
        // Every handler involved is registered directly on the highlight element anyway.
        const evt = new win.MouseEvent(type, {
            bubbles: false,
            cancelable: true,
            view: win,
            detail: source.detail,
            screenX: source.screenX,
            screenY: source.screenY,
            clientX: source.clientX,
            clientY: source.clientY,
            ctrlKey: source.ctrlKey,
            altKey: source.altKey,
            shiftKey: source.shiftKey,
            metaKey: source.metaKey,
            button: source.button,
            buttons: source.buttons,
            relatedTarget,
        });
        el.dispatchEvent(evt);

        return evt;
    }

    private hitTest(evt: MouseEvent): HTMLElement | null {
        // Elements in the annotation layer are still `pointer-events: auto` and handle their own
        // events, so don't steal events that landed on one of them.
        if (isTargetHTMLElement(evt, evt.target) && evt.target.closest('.annotationLayer section')) {
            return null;
        }

        const layerRect = this.layerEl.getBoundingClientRect();
        const x = evt.clientX - layerRect.left;
        const y = evt.clientY - layerRect.top;

        const hitRects = this.getHitRects(layerRect);
        // Iterate in reverse document order so that the topmost highlight wins,
        // which is what the native hit-testing would have done.
        for (let i = hitRects.length - 1; i >= 0; i--) {
            const { el, left, top, right, bottom } = hitRects[i];
            if (left <= x && x <= right && top <= y && y <= bottom) return el;
        }

        return null;
    }

    /**
     * The hit rectangles are stored relative to the highlight layer, so they survive scrolling
     * and only have to be recomputed when the layer itself is resized, i.e. on zoom or rotation.
     * (A re-render clears the highlights and this delegate along with them.)
     */
    private getHitRects(layerRect: DOMRect): HitRect[] {
        const cachedSize = this.hitRectsLayerSize;
        if (this.hitRects
            && cachedSize
            && Math.abs(cachedSize.width - layerRect.width) < 0.5
            && Math.abs(cachedSize.height - layerRect.height) < 0.5) {
            return this.hitRects;
        }

        const hitRects: HitRect[] = [];

        for (const child of Array.from(this.layerEl.children)) {
            if (!child.instanceOf(HTMLElement)) continue;
            if (!child.hasClass('pdf-plus-backlink')) continue;
            // Bounding rectangles of backlinked annotations have always been non-interactive.
            if (child.hasClass('pdf-plus-annotation-bounding-rect')) continue;

            const rect = child.getBoundingClientRect();
            hitRects.push({
                el: child,
                left: rect.left - layerRect.left,
                top: rect.top - layerRect.top,
                right: rect.right - layerRect.left,
                bottom: rect.bottom - layerRect.top,
            });
        }

        this.hitRects = hitRects;
        this.hitRectsLayerSize = { width: layerRect.width, height: layerRect.height };

        return hitRects;
    }
}
