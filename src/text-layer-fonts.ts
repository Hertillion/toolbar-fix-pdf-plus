import { PDFPageView, TextContentItem } from 'typings';
import { getTextLayerInfo } from 'utils';

/**
 * PDF.js lays each text content item out as a single span containing the item's whole string, and
 * corrects only the span's *total* width with `transform: scaleX(...)`.
 *
 * The font that span is rendered with is not the PDF's: in the worker, `getTextContent` reports
 * `styles[fontName].fontFamily` as `font.fallbackName`, a generic family (`serif`, `sans-serif`).
 * Since only the total width is corrected, character boxes agree with the painted glyphs at an
 * item's two ends and drift in between - by as much as a character and a half in a line of a
 * densely typeset paper. The text layer is what the browser hit-tests, so a drag over `74.1%` can
 * select `4.1%)`.
 *
 * The embedded font is not missing, though: PDF.js installs it as an `@font-face` rule named after
 * the font's loaded name, which is exactly what a text item reports as its `fontName`. Naming that
 * family on the node makes the browser lay the text out with the metrics the page was set in, and
 * leaves the text layer otherwise exactly as PDF.js built it - one span, one text node, one line
 * box. That last part matters: earlier attempts here placed each word, and then each run, in its
 * own span, which measured beautifully and dragged terribly, because turning a dragged pointer into
 * a text position needs a line box to walk and `.textLayer span { position: absolute }` - a
 * descendant selector, so it catches added spans too - leaves nothing to walk.
 *
 * What this cannot correct is the positioning the PDF does between glyphs, which is how justified
 * text is spread; that stays with PDF.js's single stretch across the item.
 */

/** Data attributes holding what a node had before, so it can be put back. */
export const ALIGNED = 'pdfPlusAligned';
const ORIGINAL_TRANSFORM = 'pdfPlusTransform';

/** The stretch PDF.js applies to an item, which has to be restated for the new font's metrics. */
const SCALE_X_PATTERN = /scaleX\(([\d.]+)\)/;

/**
 * PDF.js writes the font size as `calc(var(--total-scale-factor) * 9.60px)` so that zooming is a
 * pure CSS variable change, which means `parseFloat` gives NaN. Pull the px number out instead.
 *
 * Only the number matters, not what it is multiplied by: everything computed from it here is a
 * ratio of two widths measured at that same size, so the scale factor cancels - which is also why
 * the result stays correct across zoom levels.
 */
export function getBaseFontSize(div: HTMLElement): number {
    const match = /(-?[\d.]+)px/.exec(div.style.fontSize);
    return match ? parseFloat(match[1]) : NaN;
}

/**
 * How far, in PDF points, a single character's width under a font may sit from the width the PDF
 * gives it before that font is judged not to describe this text.
 */
const MAX_ADVANCE_ERROR = 0.5;

/** Whether a font reproduces the PDF's own character widths, decided once per font. */
export const fontVerdicts = new Map<string, { use: boolean, family: number, fallback: number }>();

let measureCtx: CanvasRenderingContext2D | null = null;

/** Single-character widths. A few hundred per font, unlike whole strings. */
const charWidths = new Map<string, number>();

function charWidth(doc: Document, font: string, char: string): number {
    const key = font + char;
    let width = charWidths.get(key);
    if (width === undefined) {
        width = measureText(doc, font, char);
        if (charWidths.size > 4000) charWidths.clear();
        charWidths.set(key, width);
    }
    return width;
}

/**
 * The worst disagreement, in PDF points, between the character widths a font gives this text and
 * the widths the PDF gives it.
 *
 * The two are in different units - one is CSS px at whatever size the node happens to be, the other
 * PDF points - so they are compared after the single scale factor that best relates them, which is
 * exactly the freedom PDF.js's own stretch has. What is left is the part no stretch can absorb:
 * characters this font proportions differently from the PDF's, or does not have at all.
 */
function advanceError(doc: Document, font: string, str: string, chars: NonNullable<TextContentItem['chars']>): number {
    let totalWidth = 0;
    let totalAdvance = 0;
    const widths: number[] = [];

    for (let k = 0; k < chars.length; k++) {
        const width = charWidth(doc, font, str.charAt(k));
        widths.push(width);
        totalWidth += width;
        totalAdvance += chars[k].r[2] - chars[k].r[0];
    }
    if (!(totalWidth > 0) || !(totalAdvance > 0)) return Infinity;

    const scale = totalAdvance / totalWidth;
    let worst = 0;
    for (let k = 0; k < widths.length; k++) {
        worst = Math.max(worst, Math.abs(scale * widths[k] - (chars[k].r[2] - chars[k].r[0])));
    }
    return worst;
}

/**
 * How much naming a family changes the width of the text it is being named for, as a ratio. Exactly
 * 1 means the browser laid the text out with the fallback either way, so the family is not one it
 * can use and naming it would achieve nothing.
 *
 * `document.fonts.check()` cannot answer this: a family nobody has heard of resolves to a fallback,
 * which is loaded, so the answer is yes for every name. Nor can a fixed probe string - the fonts in
 * a paper are usually subsets carrying only the glyphs that paper uses, and a probe of glyphs the
 * subset happens not to have would be laid out entirely in the fallback. Measuring the item's own
 * text is the only question worth asking, since that is the text that has to be laid out.
 */
export function fontEffect(doc: Document, family: string, fallback: string, fontSize: number, text: string) {
    const before = measureText(doc, `${fontSize}px ${fallback}`, text);
    const after = measureText(doc, `${fontSize}px "${family}", ${fallback}`, text);
    return { before, after, ratio: before > 0 ? after / before : 1 };
}

function measureText(doc: Document, font: string, text: string): number {
    if (!measureCtx) {
        measureCtx = doc.createElement('canvas').getContext('2d');
        if (!measureCtx) return 0;
    }
    if (measureCtx.font !== font) measureCtx.font = font;
    return measureCtx.measureText(text).width;
}

/**
 * `item.chars` covers the item's text *before* PDF.js trims it, so it can carry leading or
 * trailing entries that `item.str` does not have. Line them up, and give up unless the result
 * matches `item.str` character for character - a partial alignment would silently move text to
 * the wrong place, which is worse than the drift we are fixing.
 */
export function charsMatchingStr(item: TextContentItem): TextContentItem['chars'] | null {
    const { chars, str } = item;
    if (!chars || chars.length < str.length || !str.length) return null;

    const from = chars.findIndex((char) => char.c === str.charAt(0));
    if (from === -1) return null;
    const aligned = chars.slice(from, from + str.length);
    if (aligned.length !== str.length) return null;

    for (let i = 0; i < str.length; i++) {
        if (aligned[i].c !== str.charAt(i)) return null;
    }
    return aligned;
}

export function canAlign(item: TextContentItem): boolean {
    // Rotated or vertical text: PDF.js gives the span a `rotate(...)` of its own and our
    // horizontal-only math does not apply.
    if (item.transform[1] !== 0 || item.transform[2] !== 0) return false;
    if (item.dir !== 'ltr') return false;
    // PDF.js only corrects an item's width when it holds more than one character, so for a
    // single-character item the span is *not* stretched to `item.width` and the frame this code
    // works in would not be the frame the browser lays the span out in. There is nothing to fix
    // inside a one-character item anyway.
    if (item.str.length < 2) return false;
    return item.width > 0;
}

/**
 * Point a text layer node at the PDF's own font instead of the generic family PDF.js gives it.
 *
 * @returns whether the node was changed.
 */
export function alignTextLayerNode(div: HTMLElement, item: TextContentItem): boolean {
    if (div.dataset[ALIGNED]) return false;
    if (!item.str || !item.fontName) return false;

    const doc = div.doc;
    const family = item.fontName;
    const previous = div.style.fontFamily;
    if (!previous || previous === family) return false;

    const fontSize = getBaseFontSize(div);
    if (!(fontSize > 0)) return false;

    // PDF.js's font files are built to be drawn with, not to be laid text out with: it draws a
    // glyph by looking it up under a codepoint of its own choosing, so a font whose character map
    // was synthesised from the PDF's encoding need not answer to the Unicode the text layer holds.
    // Where it does not, characters come out of a fallback or with no width at all, and naming the
    // font makes the layer worse rather than better - which is what happened to an Elsevier paper
    // whose subset fonts left spaces and digits with zero advance.
    //
    // So ask, of this font and of the one PDF.js chose, which reproduces the widths the PDF itself
    // gives these characters, and only take the PDF's font when it wins and is right.
    let verdict = fontVerdicts.get(family);
    if (!verdict) {
        const chars = charsMatchingStr(item);
        // Judge on an item with enough text to be worth judging on; a later one will do.
        if (!chars || chars.length < 8) return false;

        const fallbackError = advanceError(doc, `${fontSize}px ${previous}`, item.str, chars);
        const familyError = advanceError(doc, `${fontSize}px "${family}", ${previous}`, item.str, chars);
        verdict = {
            use: familyError <= MAX_ADVANCE_ERROR && familyError < fallbackError,
            family: familyError,
            fallback: fallbackError,
        };
        fontVerdicts.set(family, verdict);
    }
    if (!verdict.use) return false;

    // PDF.js sized this node by measuring its text in the generic family and stretching the result
    // to the item's true width. Measured in the embedded font the text is a different width, so the
    // stretch has to be restated in the same proportion, or the line would be scaled by the ratio
    // between two fonts. PDF.js recomputes this itself the next time it lays the page out, reading
    // the family from the node - which by then is this one.
    //
    // A width that does not move is also how a family the browser cannot use announces itself: the
    // text was laid out in the fallback both times, and naming it would change nothing.
    const { before, after, ratio } = fontEffect(doc, family, previous, fontSize, item.str);
    if (!(before > 0) || !(after > 0)) return false;
    if (Math.abs(ratio - 1) < 0.0005) return false;

    const transform = div.style.transform;
    div.dataset[ALIGNED] = previous;
    div.dataset[ORIGINAL_TRANSFORM] = transform;
    div.style.fontFamily = `"${family}"`;

    // Items of a single character are given no stretch at all by PDF.js, and get none here either.
    const scaled = transform.replace(SCALE_X_PATTERN, (_, value: string) =>
        `scaleX(${(parseFloat(value) * before / after).toFixed(5)})`);
    if (scaled !== transform) div.style.transform = scaled;

    return true;
}

/** Put a text layer node back the way PDF.js built it. */
export function revertTextLayerNode(div: HTMLElement, item: TextContentItem): boolean {
    const previous = div.dataset[ALIGNED];
    if (previous === undefined) return false;

    div.style.fontFamily = previous;
    const transform = div.dataset[ORIGINAL_TRANSFORM];
    if (transform) div.style.transform = transform;
    else div.style.removeProperty('transform');

    // Earlier versions of this rewrote the node's children and gave it a width; undo that too, so
    // that a build carrying leftovers from one of them still ends up with what PDF.js made.
    if (div.childElementCount) div.replaceChildren(item.str);
    div.style.removeProperty('width');

    delete div.dataset[ALIGNED];
    delete div.dataset[ORIGINAL_TRANSFORM];
    return true;
}


/** Align (or revert) every text layer node of a page. Returns the number of nodes changed. */
export function alignTextLayer(pageView: PDFPageView, align: boolean): number {
    const info = pageView.textLayer && getTextLayerInfo(pageView.textLayer);
    if (!info) return 0;

    const { textDivs, textContentItems } = info;
    let changed = 0;
    for (let i = 0; i < textDivs.length && i < textContentItems.length; i++) {
        const div = textDivs[i];
        const item = textContentItems[i];
        if (!div || !item) continue;
        if (align ? alignTextLayerNode(div, item) : revertTextLayerNode(div, item)) changed++;
    }
    return changed;
}
