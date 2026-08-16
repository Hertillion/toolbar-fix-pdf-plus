import { PDFPageView, Rect, TextContentItem } from 'typings';
import { getCharactersWithBoundingBoxesInPDFCoords, getOffsetInTextLayerNode, getTextLayerInfo, getTextLayerNode } from 'utils';
import { ALIGNED, canAlign, charsMatchingStr, fontEffect, fontVerdicts, getBaseFontSize } from 'text-layer-fonts';

/**
 * Measuring what the option in `text-layer-fonts.ts` is worth, on whatever page is open. Nothing
 * here is used by the feature itself; it exists so the claims made for it can be checked against a
 * reader's own PDFs rather than taken on trust, and so that a change that quietly does nothing
 * shows up as numbers that did not move.
 */

export interface AlignmentReport {
    pageNumber: number;
    /** Number of characters that could be compared. */
    characters: number;
    /** Text layer nodes this page currently has, and how many of them we have re-positioned. */
    items: number;
    alignedNodes: number;
    /** Elements the text layer costs: one per node, plus the sub-spans we added. */
    elements: number;
    /**
     * Total width, in PDF points, of the horizontal gaps between consecutive characters' hit boxes.
     * PDF.js's one-span-per-item layout has none by construction; splitting an item into separately
     * placed pieces can open them, and a gap is a spot where the cursor is over no text at all,
     * which is what makes a drag stop tracking or jump.
     */
    gaps: number;
    /** Why items were left out of the measurement. */
    skipped: { notAlignable: number, charsMismatch: number, domMismatch: number };
    /** Mean and max horizontal distance, in PDF points, between painted and hit-testable boxes. */
    meanAbsDx: number;
    maxAbsDx: number;
    /**
     * The same distance kept signed. A caret goes to whichever side of a character's box the
     * pointer is nearer, so a layer sitting consistently left of the glyphs makes the character a
     * drag starts on drop out of the selection unless the pointer is placed early - which is a
     * different complaint from drifting, and needs the sign to tell apart from it.
     */
    meanDx: number;
    /**
     * The same distances measured relative to each item's own first character, which cancels any
     * constant offset - both a real one in the item's placement and any bias in the client-to-PDF
     * coordinate conversion this measurement goes through. This is the number that says how badly
     * an item's characters are distributed *within* the item, which is what the drift actually is.
     */
    meanAbsRelDx: number;
    maxAbsRelDx: number;
    /**
     * Characters whose painted midpoint lands inside a *different* character's hit box. These are
     * the ones that produce a selection different from what the pointer was over.
     */
    misHits: number;
    /**
     * The same question asked the way the browser answers it while a selection is being dragged:
     * aim at the middle of a painted character and ask `caretRangeFromPoint` which text position
     * that is. Comparing boxes is the inverse of what dragging does, and on out-of-flow boxes the
     * two are not guaranteed to agree, so this is the number that corresponds to what a pointer
     * actually does. Only characters currently on screen can be asked.
     */
    caretProbes: number;
    caretMisses: number;
    worst: { text: string, dx: number } | null;
}

/**
 * Compare where each character is painted (`item.chars`, straight from the PDF's content stream)
 * against where the browser thinks it is (the DOM boxes it hit-tests against). Both are converted
 * to PDF user space so the numbers are in points and independent of zoom.
 */
export function reportTextLayerAlignment(pageView: PDFPageView, pageNumber: number, label: string): AlignmentReport {
    const report: AlignmentReport = {
        pageNumber, characters: 0, items: 0, alignedNodes: 0, elements: 0, gaps: 0,
        skipped: { notAlignable: 0, charsMismatch: 0, domMismatch: 0 },
        meanAbsDx: 0, maxAbsDx: 0, meanDx: 0, meanAbsRelDx: 0, maxAbsRelDx: 0, misHits: 0,
        caretProbes: 0, caretMisses: 0, worst: null,
    };

    const info = pageView.textLayer && getTextLayerInfo(pageView.textLayer);
    if (!info) return report;

    const { textDivs, textContentItems } = info;
    let totalAbsDx = 0;
    let totalDx = 0;
    let totalAbsRelDx = 0;

    // The client coordinate of the page's content origin, to turn a PDF point into somewhere a
    // pointer could be. This is the inverse of what `toPDFCoords` does.
    const pageEl = pageView.div;
    const win = pageEl.win;
    const doc = pageEl.doc;
    const pageStyle = win.getComputedStyle(pageEl);
    const pageRect = pageEl.getBoundingClientRect();
    const pageLeft = pageRect.left + parseFloat(pageStyle.borderLeftWidth) + parseFloat(pageStyle.paddingLeft);
    const pageTop = pageRect.top + parseFloat(pageStyle.borderTopWidth) + parseFloat(pageStyle.paddingTop);
    const misses: { char: string, expected: number, got: number | null, text: string }[] = [];
    let probeCounter = 0;

    // What the document can actually lay text out with, and what this page asks for. If the two do
    // not meet, naming the PDF's font on a node changes nothing and the numbers below come out
    // exactly as they were.
    const installed = new Set<string>();
    doc.fonts.forEach((face) => installed.add(`${face.family}:${face.status}`));
    const requested = new Map<string, string>();
    for (let i = 0; i < textContentItems.length; i++) {
        const item = textContentItems[i];
        const div = textDivs[i];
        if (!item?.fontName || !item.str || !div || requested.has(item.fontName)) continue;
        // The family the node had before anything here touched it.
        const fallback = div.dataset[ALIGNED] || div.style.fontFamily;
        const size = getBaseFontSize(div);
        if (!fallback || !(size > 0)) continue;
        const { ratio } = fontEffect(doc, item.fontName, fallback, size, item.str);
        const verdict = fontVerdicts.get(item.fontName);
        requested.set(item.fontName, verdict
            ? `${verdict.use ? 'USED' : 'rejected'} pdf=${verdict.family.toFixed(2)}pt `
            + `fallback=${verdict.fallback.toFixed(2)}pt width×${ratio.toFixed(4)}`
            : `undecided width×${ratio.toFixed(4)}`);
    }
    console.log(`[PDF++] ${label}: fonts`, {
        installed: [...installed].slice(0, 30),
        installedCount: installed.size,
        // Per font: how far its character widths are from the PDF's own, against the same for the
        // family PDF.js chose. The PDF's font is only used when it is both better and right.
        perFont: Object.fromEntries(requested),
    });

    /** Ask the browser which text position the middle of a painted character is. */
    const probeCaret = (div: HTMLElement, item: TextContentItem, box: Rect, index: number) => {
        const [vx, vy] = pageView.viewport.convertToViewportPoint(
            (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        );
        const x = pageLeft + vx;
        const y = pageTop + vy;
        // Off-screen points cannot be hit-tested, and asking anyway would count as a miss.
        if (x < 0 || y < 0 || x > win.innerWidth || y > win.innerHeight) return;

        report.caretProbes++;
        const range = doc.caretRangeFromPoint(x, y);
        const node = range?.startContainer;
        const offset = node && getTextLayerNode(pageEl, node) === div
            ? getOffsetInTextLayerNode(div, node, range!.startOffset)
            : null;
        // A caret sits between characters, so aiming at the middle of character `index` may
        // legitimately come back as either of its two sides.
        if (offset === index || offset === index + 1) return;

        report.caretMisses++;
        if (misses.length < 12) {
            misses.push({
                char: item.str.charAt(index), expected: index, got: offset,
                text: item.str.slice(Math.max(0, index - 8), index + 8),
            });
        }
    };
    let worstDetail: {
        index: number, at: number, str: string, base: number,
        chars: NonNullable<TextContentItem['chars']>,
        domBoxes: { char: string, rect: number[] }[],
    } | null = null;

    for (let i = 0; i < textDivs.length && i < textContentItems.length; i++) {
        const div = textDivs[i];
        const item = textContentItems[i];
        if (!div || !item || !item.str) continue;

        report.items++;
        report.elements += 1 + div.childElementCount;
        if (div.dataset[ALIGNED]) report.alignedNodes++;

        if (!canAlign(item)) {
            report.skipped.notAlignable++;
            continue;
        }
        const chars = charsMatchingStr(item);
        if (!chars) {
            report.skipped.charsMismatch++;
            continue;
        }

        const domBoxes = [...getCharactersWithBoundingBoxesInPDFCoords(pageView, div)];
        if (domBoxes.length !== chars.length) {
            report.skipped.domMismatch++;
            continue;
        }

        const dxAtItemStart = domBoxes[0].rect[0] - chars[0].r[0];

        for (let k = 1; k < domBoxes.length; k++) {
            report.gaps += Math.max(0, domBoxes[k].rect[0] - domBoxes[k - 1].rect[2]);
        }

        for (let k = 0; k < chars.length; k++) {
            const painted = chars[k].r;
            const dom = domBoxes[k].rect;
            const dx = dom[0] - painted[0];
            const relDx = dx - dxAtItemStart;

            report.characters++;
            totalAbsDx += Math.abs(dx);
            totalDx += dx;
            totalAbsRelDx += Math.abs(relDx);
            if (Math.abs(relDx) > report.maxAbsRelDx) report.maxAbsRelDx = Math.abs(relDx);
            if (Math.abs(dx) > report.maxAbsDx) report.maxAbsDx = Math.abs(dx);
            // Report the worst *relative* offset: a constant offset shared by a whole item is not
            // what makes a drag land on the wrong character.
            if (Math.abs(relDx) >= report.maxAbsRelDx) {
                report.worst = { text: item.str.slice(Math.max(0, k - 12), k + 12), dx: relDx };
                worstDetail = { index: i, at: k, str: item.str, chars, domBoxes, base: dxAtItemStart };
            }

            // Where does a click on the middle of the painted glyph actually land?
            const midpoint = (painted[0] + painted[2]) / 2;
            if (midpoint < Math.min(dom[0], dom[2]) || midpoint > Math.max(dom[0], dom[2])) {
                report.misHits++;
            }

            // Sampled rather than exhaustive: each of these forces a hit test.
            if (probeCounter++ % 4 === 0) probeCaret(div, item, painted, k);
        }

    }

    if (misses.length) {
        console.log(`[PDF++] ${label}: where the pointer actually lands, for the first misses:`);
        console.table(misses);
    }

    // Show the character-by-character numbers for whichever line came off worst, so there is
    // always something concrete to look at without having to know where to probe.
    if (worstDetail) {
        const { index, at, str, chars, domBoxes, base } = worstDetail;
        const from = Math.max(0, at - 6);
        const to = Math.min(chars.length, at + 7);
        console.log(
            `[PDF++] ${label}: worst line is item ${index} `
            + `(offset of the whole item: ${base.toFixed(2)}pt): ${JSON.stringify(str)}`
        );
        console.table(
            chars.slice(from, to).map((char, n) => {
                const dx = domBoxes[from + n].rect[0] - char.r[0];
                return {
                    idx: from + n,
                    char: char.c,
                    paintedX: +char.r[0].toFixed(2),
                    domX: +domBoxes[from + n].rect[0].toFixed(2),
                    dx: +dx.toFixed(2),
                    relDx: +(dx - base).toFixed(2),
                };
            })
        );
    }

    report.meanAbsDx = report.characters ? totalAbsDx / report.characters : 0;
    report.meanDx = report.characters ? totalDx / report.characters : 0;
    report.meanAbsRelDx = report.characters ? totalAbsRelDx / report.characters : 0;
    return report;
}
