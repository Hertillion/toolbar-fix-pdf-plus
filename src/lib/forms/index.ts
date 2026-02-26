import { Notice, TFile } from 'obsidian';

import { PDFDocument } from '@cantoo/pdf-lib';

import PDFPlus from 'main';
import { PDFPlusLibSubmodule } from 'lib/submodule';
import { PDFViewerChild } from 'typings';

export type PdfFormFieldValue = string | string[] | boolean | null;

export type PdfFormFieldType =
    | 'text'
    | 'checkbox'
    | 'radio'
    | 'dropdown'
    | 'option-list'
    | 'unknown';

export type PdfFormFieldValueSource = 'fieldObjects' | 'annotationStorage' | 'dom';

export interface CollectedPdfFormFieldState {
    name: string;
    type: PdfFormFieldType;
    value: PdfFormFieldValue;
    source: PdfFormFieldValueSource;
}

export interface CollectedPdfFormState {
    /** Whether the PDF appears to contain interactive form fields. */
    hasForms: boolean;
    /** Field state keyed by the PDF field name. */
    fields: Map<string, CollectedPdfFormFieldState>;
}

type ChildSaveState = {
    dirty: boolean;
    inFlight: boolean;
    queued: boolean;
    timerId: number | null;
};

function isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStorageEntries(all: unknown): Array<[string, any]> {
    if (!all) return [];
    if (all instanceof Map) {
        return Array.from(all.entries()).map(([k, v]) => [String(k), v]);
    }
    if (Array.isArray(all)) {
        return all
            .filter((entry) => Array.isArray(entry) && entry.length >= 2)
            .map((entry) => [String(entry[0]), entry[1]]);
    }
    if (isRecord(all)) {
        return Object.entries(all).map(([k, v]) => [k, v]);
    }
    return [];
}

function extractAnnotationStorageValue(value: any): unknown {
    if (value === null || value === undefined) return null;
    if (!isRecord(value)) return value;
    if ('value' in value) return value.value;
    if ('formattedValue' in value) return value.formattedValue;
    if ('valueAsString' in value) return value.valueAsString;
    return value;
}

function coerceToFieldValue(value: unknown): PdfFormFieldValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (typeof value === 'number') return String(value);
    return String(value);
}

export class PdfFormsLib extends PDFPlusLibSubmodule {
    private childState = new WeakMap<PDFViewerChild, ChildSaveState>();

    constructor(plugin: PDFPlus) {
        super(plugin);
    }

    private getState(child: PDFViewerChild): ChildSaveState {
        let state = this.childState.get(child);
        if (!state) {
            state = { dirty: false, inFlight: false, queued: false, timerId: null };
            this.childState.set(child, state);
        }
        return state;
    }

    isEnabled() {
        // This feature is a subset of “editing PDF files”, so keep it behind the same safety gate.
        return this.plugin.settings.enablePDFEdit && this.plugin.settings.enablePdfFormSave;
    }

    isAutoSaveEnabled() {
        return this.isEnabled() && this.plugin.settings.autoSavePdfForms;
    }

    getAutoSaveDebounceMs() {
        const ms = this.plugin.settings.autoSavePdfFormsDebounceMs;
        return typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 2000;
    }

    /**
     * Register event listeners that mark the PDF forms as dirty and optionally auto-save.
     * This should be called after the viewer DOM is ready.
     */
    registerFormChangeListeners(child: PDFViewerChild, viewerContainerEl: HTMLElement) {
        if (!this.isEnabled()) return;

        const handler = (evt: Event) => {
            if (!(evt.target instanceof HTMLElement)) return;
            if (!evt.target.closest('.annotationLayer')) return;
            if (!evt.target.matches('input, textarea, select')) return;
            this.markDirty(child);
        };

        // Capture phase so we see changes early and reliably.
        child.component?.registerDomEvent(viewerContainerEl, 'input', handler, { capture: true });
        child.component?.registerDomEvent(viewerContainerEl, 'change', handler, { capture: true });
    }

    markDirty(child: PDFViewerChild) {
        const state = this.getState(child);
        state.dirty = true;

        if (!this.isAutoSaveEnabled()) return;

        if (state.timerId !== null) {
            window.clearTimeout(state.timerId);
        }

        state.timerId = window.setTimeout(() => {
            state.timerId = null;
            this.saveFormFields(child, { silent: true }).catch((e) => console.error(e));
        }, this.getAutoSaveDebounceMs());
    }

    async hasForms(child: PDFViewerChild): Promise<boolean> {
        const doc = child.pdfViewer.pdfViewer?.pdfDocument;
        if (!doc) return false;

        const getFieldObjects = (doc as any).getFieldObjects;
        if (typeof getFieldObjects === 'function') {
            try {
                const fieldObjects = await getFieldObjects.call(doc);
                if (isRecord(fieldObjects) && Object.keys(fieldObjects).length > 0) return true;
            } catch {
                // ignore
            }
        }

        // Fallback: if any form control exists in rendered annotation layers, treat as forms present.
        if (child.pdfViewer.dom?.viewerEl?.querySelector('.annotationLayer input, .annotationLayer textarea, .annotationLayer select')) {
            return true;
        }

        return false;
    }

    private getAnnotationStorage(child: PDFViewerChild): any | null {
        // Best-effort: Obsidian’s PDF.js may expose it in different places across versions.
        const pages = child.pdfViewer.pdfViewer?._pages;
        if (Array.isArray(pages)) {
            for (const pageView of pages) {
                const storage = pageView?.annotationLayer?.annotationStorage;
                if (storage) return storage;
            }
        }
        const maybeStorage = (child.pdfViewer.pdfViewer as any)?.annotationStorage;
        return maybeStorage ?? null;
    }

    async collectFormState(child: PDFViewerChild): Promise<CollectedPdfFormState> {
        const fields = new Map<string, CollectedPdfFormFieldState>();

        const doc = child.pdfViewer.pdfViewer?.pdfDocument;
        if (!doc) return { hasForms: false, fields };

        const widgetIdToFieldName = new Map<string, { name: string; type: PdfFormFieldType }>();
        let hasForms = false;

        // 1) Field objects (best mapping to actual field names)
        const getFieldObjects = (doc as any).getFieldObjects;
        if (typeof getFieldObjects === 'function') {
            try {
                const fieldObjects = await getFieldObjects.call(doc);
                if (isRecord(fieldObjects) && Object.keys(fieldObjects).length > 0) {
                    hasForms = true;
                    for (const [fieldName, widgets] of Object.entries(fieldObjects)) {
                        const first = Array.isArray(widgets) ? widgets[0] : null;
                        const fieldTypeCode = first?.type ?? first?.fieldType ?? first?.fieldTypeCode ?? null;
                        const type = this.normalizeFieldType(fieldTypeCode, first);

                        if (!fields.has(fieldName)) {
                            const value = coerceToFieldValue(first?.value);
                            fields.set(fieldName, {
                                name: fieldName,
                                type,
                                value,
                                source: 'fieldObjects',
                            });
                        }

                        if (Array.isArray(widgets)) {
                            for (const w of widgets) {
                                const id = w?.id;
                                if (typeof id === 'string' && id) {
                                    widgetIdToFieldName.set(id, { name: fieldName, type });
                                }
                            }
                        }
                    }
                }
            } catch {
                // ignore
            }
        }

        // 2) AnnotationStorage overrides (captures live edits)
        const annotationStorage = this.getAnnotationStorage(child);
        if (annotationStorage) {
            const all =
                typeof annotationStorage.getAll === 'function'
                    ? annotationStorage.getAll()
                    : (annotationStorage.all ?? annotationStorage.storage ?? annotationStorage.serializable ?? null);

            for (const [widgetId, raw] of normalizeStorageEntries(all)) {
                const mapped = widgetIdToFieldName.get(widgetId);
                if (!mapped) continue;

                const value = coerceToFieldValue(extractAnnotationStorageValue(raw));
                fields.set(mapped.name, {
                    name: mapped.name,
                    type: mapped.type,
                    value,
                    source: 'annotationStorage',
                });
            }
        }

        // 3) DOM fallback (rendered pages only)
        const domRoot = child.pdfViewer.dom?.viewerEl;
        if (domRoot) {
            const controls = Array.from(domRoot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
                '.annotationLayer input, .annotationLayer textarea, .annotationLayer select'
            ));
            if (controls.length > 0) hasForms = true;

            const radioSelections = new Map<string, string>();

            for (const el of controls) {
                const tag = el.tagName.toLowerCase();
                const typeAttr = (el instanceof HTMLInputElement ? el.type : '').toLowerCase();

                const section = el.closest<HTMLElement>('section[data-annotation-id]');
                const widgetId = section?.dataset?.annotationId;
                const mapped = widgetId ? widgetIdToFieldName.get(widgetId) : null;

                const name =
                    (el.getAttribute('name') && el.getAttribute('name')!.trim()) ||
                    (mapped?.name ?? null) ||
                    (el.getAttribute('data-field-name') && el.getAttribute('data-field-name')!.trim()) ||
                    null;
                if (!name) continue;

                if (tag === 'input' && typeAttr === 'radio') {
                    const input = el as HTMLInputElement;
                    if (input.checked) {
                        radioSelections.set(name, input.value ?? 'true');
                    }
                    continue;
                }

                const { type, value } = this.extractDomValue(el);
                if (value === null && value !== false && value !== '') continue;

                fields.set(name, {
                    name,
                    type: mapped?.type ?? type,
                    value,
                    source: 'dom',
                });
            }

            for (const [name, value] of radioSelections.entries()) {
                fields.set(name, {
                    name,
                    type: 'radio',
                    value,
                    source: 'dom',
                });
            }
        }

        return { hasForms, fields };
    }

    private normalizeFieldType(typeCode: unknown, fieldObject: any): PdfFormFieldType {
        const code = typeof typeCode === 'string' ? typeCode : '';
        // PDF.js uses PDF field types (Tx, Btn, Ch, Sig) in many builds.
        if (code === 'Tx') return 'text';
        if (code === 'Ch') {
            const isCombo = !!fieldObject?.combo;
            return isCombo ? 'dropdown' : 'option-list';
        }
        if (code === 'Sig') return 'unknown';
        if (code === 'Btn') {
            // Disambiguate checkbox vs radio if possible.
            if (fieldObject?.radioButton) return 'radio';
            if (fieldObject?.checkBox) return 'checkbox';
            // Some builds use `buttonType`.
            const bt = String(fieldObject?.buttonType ?? '').toLowerCase();
            if (bt.includes('radio')) return 'radio';
            if (bt.includes('check')) return 'checkbox';
            return 'checkbox';
        }
        return 'unknown';
    }

    private extractDomValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): { type: PdfFormFieldType; value: PdfFormFieldValue } {
        if (el instanceof HTMLInputElement) {
            const type = el.type.toLowerCase();
            if (type === 'checkbox') return { type: 'checkbox', value: !!el.checked };
            if (type === 'radio') return { type: 'radio', value: el.checked ? (el.value ?? 'true') : null };
            return { type: 'text', value: el.value ?? '' };
        }
        if (el instanceof HTMLTextAreaElement) {
            return { type: 'text', value: el.value ?? '' };
        }
        // HTMLSelectElement
        if (el.multiple) {
            return { type: 'option-list', value: Array.from(el.selectedOptions).map((o) => o.value) };
        }
        return { type: 'dropdown', value: el.value ?? '' };
    }

    /**
     * Save current form field values into the underlying PDF file (without flattening).
     */
    async saveFormFields(child: PDFViewerChild, options?: { silent?: boolean }): Promise<boolean> {
        if (!this.isEnabled()) {
            if (!options?.silent) {
                new Notice(`${this.plugin.manifest.name}: Enable PDF editing to save form fields.`);
            }
            return false;
        }

        if (!this.lib.isEditable(child)) {
            if (!options?.silent) {
                new Notice(`${this.plugin.manifest.name}: This PDF cannot be edited (e.g. external file or PDF editing disabled).`);
            }
            return false;
        }

        const file = child.file;
        if (!(file instanceof TFile)) return false;

        const state = this.getState(child);
        if (state.inFlight) {
            state.queued = true;
            return true;
        }

        state.inFlight = true;
        try {
            const collected = await this.collectFormState(child);
            if (!collected.hasForms || collected.fields.size === 0) {
                if (!options?.silent) {
                    new Notice(`${this.plugin.manifest.name}: No form fields found in this PDF.`);
                }
                state.dirty = false;
                return false;
            }

            await this.writeFormStateToFile(file, collected.fields);

            state.dirty = false;
            if (!options?.silent) {
                new Notice(`${this.plugin.manifest.name}: Saved PDF form fields.`);
            }
            return true;
        } finally {
            state.inFlight = false;
            const shouldRunAgain = state.queued;
            state.queued = false;
            if (shouldRunAgain) {
                this.saveFormFields(child, { silent: true }).catch((e) => console.error(e));
            }
        }
    }

    /**
     * Called when a PDF viewer is unloading. If auto-save is enabled and forms are dirty, try a final save.
     */
    onChildUnload(child: PDFViewerChild) {
        const state = this.getState(child);
        if (state.timerId !== null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }

        if (this.isAutoSaveEnabled() && state.dirty) {
            this.saveFormFields(child, { silent: true }).catch((e) => console.error(e));
        }
    }

    private async writeFormStateToFile(file: TFile, fields: Map<string, CollectedPdfFormFieldState>) {
        const pdfDoc = await this.lib.loadPdfLibDocument(file);
        await this.applyFormStateToPdfLibDocument(pdfDoc, fields);
        await this.app.vault.modifyBinary(file, await pdfDoc.save());
    }

    private async applyFormStateToPdfLibDocument(pdfDoc: PDFDocument, fields: Map<string, CollectedPdfFormFieldState>) {
        const form = (pdfDoc as any).getForm?.();
        if (!form) {
            throw new Error('pdf-lib form API not available');
        }

        const pdfLibFields: any[] = typeof form.getFields === 'function' ? form.getFields() : [];
        const byName = new Map<string, any>();
        for (const f of pdfLibFields) {
            try {
                const name = typeof f.getName === 'function' ? f.getName() : null;
                if (typeof name === 'string') byName.set(name, f);
            } catch {
                // ignore
            }
        }

        for (const [name, state] of fields.entries()) {
            const field = byName.get(name);
            if (!field) continue;
            this.applyValueToPdfLibField(field, state);
        }

        // Best-effort: ensure appearances are up-to-date but do not flatten.
        if (typeof form.updateFieldAppearances === 'function') {
            try {
                await form.updateFieldAppearances();
            } catch {
                // ignore
            }
        }
    }

    private applyValueToPdfLibField(field: any, state: CollectedPdfFormFieldState) {
        const value = state.value;

        // Prefer type-guided updates first, then fall back to “duck-typed” methods.
        switch (state.type) {
            case 'checkbox': {
                const bool = value === true || value === 'true' || value === 'Yes' || value === 'On' || value === '1';
                if (typeof field.check === 'function' && typeof field.uncheck === 'function') {
                    bool ? field.check() : field.uncheck();
                    return;
                }
                break;
            }
            case 'radio':
            case 'dropdown':
            case 'option-list': {
                if (typeof field.select === 'function') {
                    try {
                        if (Array.isArray(value)) {
                            field.select(value);
                        } else if (value !== null) {
                            field.select(String(value));
                        }
                        return;
                    } catch {
                        // ignore and fall through
                    }
                }
                break;
            }
            case 'text': {
                if (typeof field.setText === 'function') {
                    field.setText(value === null ? '' : String(value));
                    return;
                }
                break;
            }
            case 'unknown':
                break;
        }

        // Fallback: attempt common operations.
        if (typeof field.setText === 'function') {
            field.setText(value === null ? '' : String(value));
            return;
        }
        if (typeof field.select === 'function' && value !== null) {
            try {
                Array.isArray(value) ? field.select(value) : field.select(String(value));
                return;
            } catch {
                // ignore
            }
        }
        if (typeof field.check === 'function' && typeof field.uncheck === 'function') {
            const bool = !!value && value !== 'false' && value !== 'Off' && value !== '0';
            bool ? field.check() : field.uncheck();
        }
    }
}

