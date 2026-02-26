import { Modal, Notice, TFile, setIcon } from 'obsidian';

import { PDFDocument } from '@cantoo/pdf-lib';

import PDFPlus from 'main';
import { PDFPlusLibSubmodule } from 'lib/submodule';
import { ObsidianViewer, PDFPageView, PDFViewerChild } from 'typings';

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

export type FormSaveStateListener = (info: { dirty: boolean; saving: boolean; progress: number }) => void;

type ChildSaveState = {
    dirty: boolean;
    inFlight: boolean;
    queued: boolean;
    queuedSilent: boolean;
    timerId: number | null;
    disposed: boolean;
};

type CachedPdfDoc = {
    pdfDoc: PDFDocument;
    freshness: FileFreshness;
};

type FileFreshness = {
    mtime: number;
    size: number;
};

type PDFDocumentLike = {
    getFieldObjects?: () => Promise<unknown>;
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
    private readonly closeSaveModalOptions = {
        title: 'Saving PDF form fields',
        message: 'Saving changes before closing...',
    };

    private childState = new WeakMap<PDFViewerChild, ChildSaveState>();
    private autoFitRegistered = new WeakSet<PDFViewerChild>();
    private autoFitRafByEl = new WeakMap<HTMLElement, number>();
    private textMeasureCtx: CanvasRenderingContext2D | null = null;

    private pdfDocCache = new Map<string, CachedPdfDoc>();
    private stateListeners = new WeakMap<PDFViewerChild, Set<FormSaveStateListener>>();
    private preloadingFiles = new Set<string>();

    constructor(plugin: PDFPlus) {
        super(plugin);
        this.plugin.registerEvent(this.app.vault.on('modify', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'pdf') return;
            this.invalidatePdfDocCache(file.path);
        }));
        this.plugin.registerEvent(this.app.vault.on('delete', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'pdf') return;
            this.invalidatePdfDocCache(file.path);
        }));
        this.plugin.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (!(file instanceof TFile) || file.extension !== 'pdf') return;
            this.invalidatePdfDocCache(oldPath);
            this.invalidatePdfDocCache(file.path);
        }));
    }

    private getFileFreshness(file: TFile): FileFreshness {
        return { mtime: file.stat.mtime, size: file.stat.size };
    }

    private isFreshnessEqual(a: FileFreshness, b: FileFreshness): boolean {
        return a.mtime === b.mtime && a.size === b.size;
    }

    private getState(child: PDFViewerChild): ChildSaveState {
        let state = this.childState.get(child);
        if (!state) {
            state = { dirty: false, inFlight: false, queued: false, queuedSilent: true, timerId: null, disposed: false };
            this.childState.set(child, state);
        }
        return state;
    }

    private isChildUsableForSave(child: PDFViewerChild, state?: ChildSaveState): boolean {
        const saveState = state ?? this.getState(child);
        if (saveState.disposed) return false;
        if ((child as any).unloaded) return false;
        return child.file instanceof TFile;
    }

    isEnabled() {
        return this.plugin.settings.enablePDFEdit && this.plugin.settings.enablePdfFormSave;
    }

    private isAutoFitEnabled() {
        return true;
    }

    isAutoSaveEnabled() {
        return this.isEnabled() && this.plugin.settings.autoSavePdfForms;
    }

    getAutoSaveDebounceMs() {
        const ms = this.plugin.settings.autoSavePdfFormsDebounceMs;
        return typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 2000;
    }

    isDirty(child: PDFViewerChild): boolean {
        return this.getState(child).dirty;
    }

    isSaving(child: PDFViewerChild): boolean {
        return this.getState(child).inFlight;
    }

    shouldConfirmUnsavedOnClose(): boolean {
        return !!this.plugin.settings.confirmUnsavedPdfFormsOnClose;
    }

    async handlePendingFormChangesBeforeClose(child: PDFViewerChild): Promise<boolean> {
        if (!this.shouldConfirmUnsavedOnClose()) return true;
        if (!this.isEnabled()) return true;
        if (!this.isDirty(child)) return true;

        if (this.isAutoSaveEnabled()) {
            return await this.waitForSaveWithModal(child, this.closeSaveModalOptions);
        }

        const action = await this.showUnsavedChangesPromptModal();
        if (action === 'cancel') return false;
        if (action === 'discard') return true;

        return await this.waitForSaveWithModal(child, this.closeSaveModalOptions);
    }

    private async showUnsavedChangesPromptModal(): Promise<'save' | 'discard' | 'cancel'> {
        return await new Promise((resolve) => {
            let decided = false;
            const done = (value: 'save' | 'discard' | 'cancel') => {
                if (decided) return;
                decided = true;
                resolve(value);
                modal.close();
            };

            const modal = new Modal(this.app);
            const onClose = modal.onClose.bind(modal);
            modal.onOpen = () => {
                modal.titleEl.setText('Unsaved PDF form changes');
                modal.contentEl.empty();
                modal.contentEl.createEl('p', {
                    text: 'Save form changes before closing this PDF?',
                    cls: 'pdf-plus-form-save-confirm-text',
                });

                const actionsEl = modal.contentEl.createDiv('pdf-plus-form-save-confirm-actions');
                actionsEl.createEl('button', { text: 'Save', cls: 'mod-cta' })
                    .addEventListener('click', () => done('save'));
                actionsEl.createEl('button', { text: 'Don\'t save' })
                    .addEventListener('click', () => done('discard'));
                actionsEl.createEl('button', { text: 'Cancel' })
                    .addEventListener('click', () => done('cancel'));
            };
            modal.onClose = () => {
                onClose();
                if (!decided) {
                    decided = true;
                    resolve('cancel');
                }
            };
            modal.open();
        });
    }

    private async waitForSaveWithModal(
        child: PDFViewerChild,
        options: { title: string; message: string },
    ): Promise<boolean> {
        if (!this.isDirty(child) && !this.isSaving(child)) return true;

        return await new Promise((resolve) => {
            let settled = false;
            let cancelled = false;
            let progressEl: HTMLElement | null = null;

            const finish = (ok: boolean) => {
                if (settled) return;
                settled = true;
                unregister?.();
                resolve(ok);
                modal.close();
            };

            const updateProgress = (progress: number) => {
                if (!progressEl) return;
                const pct = Math.min(99, Math.max(0, Math.round(progress)));
                progressEl.setText(`Saving... ${pct}%`);
            };

            const modal = new Modal(this.app);
            const onClose = modal.onClose.bind(modal);
            modal.onOpen = () => {
                modal.titleEl.setText(options.title);
                modal.contentEl.empty();

                const row = modal.contentEl.createDiv('pdf-plus-form-save-wait-row');
                const spinnerEl = row.createDiv('pdf-plus-form-save-wait-spinner');
                setIcon(spinnerEl, 'lucide-loader-circle');
                spinnerEl.addClass('is-spinning');

                progressEl = row.createDiv('pdf-plus-form-save-wait-message');
                progressEl.setText(options.message);

                const actionsEl = modal.contentEl.createDiv('pdf-plus-form-save-confirm-actions');
                actionsEl.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
                    cancelled = true;
                    finish(false);
                });
            };
            modal.onClose = () => {
                onClose();
                if (!settled) {
                    settled = true;
                    unregister?.();
                    resolve(false);
                }
            };

            const unregister = this.registerStateListener(child, ({ dirty, saving, progress }) => {
                updateProgress(progress);
                if (!cancelled && !dirty && !saving) {
                    finish(true);
                }
            });

            modal.open();

            const canStartSave = this.isDirty(child) && !this.isSaving(child);
            if (canStartSave) {
                const savePromise = this.saveFormFields(child, { silent: true });
                savePromise.then((ok) => {
                    if (!ok && this.isDirty(child) && !settled) {
                        new Notice(`${this.plugin.manifest.name}: Failed to save PDF form fields.`);
                        finish(false);
                    }
                }).catch((e) => {
                    console.error(e);
                    if (!settled) {
                        new Notice(`${this.plugin.manifest.name}: Failed to save PDF form fields.`);
                        finish(false);
                    }
                });
            } else if (!this.isDirty(child) && !this.isSaving(child)) {
                finish(true);
            }
        });
    }

    registerStateListener(child: PDFViewerChild, cb: FormSaveStateListener): () => void {
        let listeners = this.stateListeners.get(child);
        if (!listeners) {
            listeners = new Set();
            this.stateListeners.set(child, listeners);
        }
        listeners.add(cb);
        return () => listeners!.delete(cb);
    }

    private notifyListeners(child: PDFViewerChild, progress: number) {
        const state = this.getState(child);
        const listeners = this.stateListeners.get(child);
        if (!listeners) return;
        const info = { dirty: state.dirty, saving: state.inFlight, progress };
        for (const cb of listeners) {
            try { cb(info); } catch { /* ignore */ }
        }
    }

    // --- PDFDocument caching ---

    private async getOrLoadPdfDoc(file: TFile): Promise<PDFDocument> {
        const cached = this.pdfDocCache.get(file.path);
        const currentFreshness = this.getFileFreshness(file);
        if (cached && this.isFreshnessEqual(currentFreshness, cached.freshness)) {
            return cached.pdfDoc;
        }
        this.pdfDocCache.delete(file.path);
        const pdfDoc = await this.lib.loadPdfLibDocument(file);
        return pdfDoc;
    }

    private cachePdfDoc(file: TFile, pdfDoc: PDFDocument) {
        this.pdfDocCache.set(file.path, { pdfDoc, freshness: this.getFileFreshness(file) });
    }

    invalidatePdfDocCache(filePath: string) {
        this.pdfDocCache.delete(filePath);
    }

    private preloadPdfDoc(child: PDFViewerChild) {
        const file = child.file;
        if (!(file instanceof TFile)) return;
        if (this.pdfDocCache.has(file.path)) return;
        if (this.preloadingFiles.has(file.path)) return;

        this.preloadingFiles.add(file.path);
        this.lib.loadPdfLibDocument(file).then((pdfDoc) => {
            const currentFreshness = this.getFileFreshness(file);
            const cached = this.pdfDocCache.get(file.path);
            if (!cached || !this.isFreshnessEqual(cached.freshness, currentFreshness)) {
                this.pdfDocCache.set(file.path, { pdfDoc, freshness: currentFreshness });
            }
        }).catch(() => {}).finally(() => {
            this.preloadingFiles.delete(file.path);
        });
    }

    // --- Autosave scheduling ---

    private scheduleAutoSave(child: PDFViewerChild, delayMs: number) {
        const state = this.getState(child);
        if (state.timerId !== null) {
            window.clearTimeout(state.timerId);
        }
        state.timerId = window.setTimeout(() => {
            state.timerId = null;
            if (!state.dirty) return;

            if (this.isActivelyEditingFormField(child)) {
                this.scheduleAutoSave(child, 400);
                return;
            }

            this.saveFormFields(child, { silent: true }).catch((e) => console.error(e));
        }, Math.max(0, delayMs));
    }

    private isActivelyEditingFormField(child: PDFViewerChild): boolean {
        const viewerContainerEl = child.pdfViewer?.dom?.viewerContainerEl;
        if (!viewerContainerEl) return false;

        const doc = viewerContainerEl.doc ?? viewerContainerEl.ownerDocument;
        const activeEl = doc?.activeElement;
        if (!(activeEl instanceof HTMLElement)) return false;
        if (!viewerContainerEl.contains(activeEl)) return false;
        if (!activeEl.matches('input, textarea, select')) return false;
        return !!activeEl.closest('.annotationLayer');
    }

    private async waitForPdfDocument(child: PDFViewerChild): Promise<PDFDocumentLike | null> {
        const currentDoc = child.pdfViewer?.pdfViewer?.pdfDocument as PDFDocumentLike | null | undefined;
        if (currentDoc) return currentDoc;

        const viewer = child.pdfViewer ?? null;
        if (!viewer) return null;

        return await new Promise<PDFDocumentLike | null>((resolve) => {
            let resolved = false;
            const done = (doc: PDFDocumentLike | null) => {
                if (resolved) return;
                resolved = true;
                resolve(doc);
            };

            this.lib.onDocumentReady(viewer, (doc) => done((doc as PDFDocumentLike) ?? null));
            window.setTimeout(() => {
                done((child.pdfViewer?.pdfViewer?.pdfDocument as PDFDocumentLike | null) ?? null);
            }, 2000);
        });
    }

    // --- Form change listeners ---

    registerFormChangeListeners(child: PDFViewerChild, viewerContainerEl: HTMLElement) {
        this.registerAutoFitTextInForms(child, viewerContainerEl);

        if (!this.isEnabled()) return;

        const handler = (evt: Event) => {
            if (!(evt.target instanceof HTMLElement)) return;
            if (!evt.target.closest('.annotationLayer')) return;
            if (!evt.target.matches('input, textarea, select')) return;
            this.markDirty(child);
        };

        child.component?.registerDomEvent(viewerContainerEl, 'input', handler, { capture: true });
        child.component?.registerDomEvent(viewerContainerEl, 'change', handler, { capture: true });
    }

    private static readonly NON_TEXT_TYPES = new Set([
        'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color',
    ]);

    private registerAutoFitTextInForms(child: PDFViewerChild, _viewerContainerEl: HTMLElement) {
        if (!this.isAutoFitEnabled()) return;
        if (this.autoFitRegistered.has(child)) return;
        this.autoFitRegistered.add(child);

        const viewer: ObsidianViewer | null = child.pdfViewer ?? null;
        if (!viewer) return;

        this.lib.onAnnotationLayerReady(viewer, child.component ?? null, (_pageNumber: number, pageView: PDFPageView) => {
            const layer = pageView.annotationLayer?.div;
            if (!layer) return;
            this.setupAutoFitForLayer(layer);
        });

        window.setTimeout(() => {
            const viewerEl = child.pdfViewer?.dom?.viewerEl;
            if (viewerEl) this.setupAutoFitForLayer(viewerEl);
        }, 0);
    }

    private isTextFormControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
        if (el instanceof HTMLTextAreaElement) return true;
        if (!(el instanceof HTMLInputElement)) return false;
        const type = (el.getAttribute('type') ?? el.type ?? 'text').toLowerCase();
        return !PdfFormsLib.NON_TEXT_TYPES.has(type);
    }

    private setupAutoFitForLayer(root: ParentNode) {
        const controls = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            '.annotationLayer input, .annotationLayer textarea',
        );
        for (const el of controls) {
            if (!this.isTextFormControl(el)) continue;

            if (el.dataset.pdfPlusAutoFitBound === 'true') {
                this.fitTextControlToBox(el);
                continue;
            }
            el.dataset.pdfPlusAutoFitBound = 'true';

            const onInput = () => {
                const existing = this.autoFitRafByEl.get(el);
                if (existing) cancelAnimationFrame(existing);
                this.autoFitRafByEl.set(el, requestAnimationFrame(() => {
                    this.autoFitRafByEl.delete(el);
                    this.fitTextControlToBox(el);
                }));
            };
            el.addEventListener('input', onInput);
            el.addEventListener('change', onInput);

            this.fitTextControlToBox(el);
        }
    }

    private fitTextControlToBox(el: HTMLInputElement | HTMLTextAreaElement) {
        if (!el.isConnected) return;
        if (!el.closest('.annotationLayer')) return;

        const section = el.closest<HTMLElement>('section[data-annotation-id]');
        const visualRect = (section ?? el).getBoundingClientRect();
        const availableW = Math.max(0, visualRect.width - 2);
        const availableH = Math.max(0, visualRect.height - 2);
        if (availableW <= 2 || availableH <= 2) return;

        const ds = el.dataset;
        const computed = window.getComputedStyle(el);
        const storedBase = ds.pdfPlusAutoFitBaseFontSize;
        const rawBase = storedBase ? parseFloat(storedBase) : (parseFloat(computed.fontSize) || 12);
        if (!storedBase) ds.pdfPlusAutoFitBaseFontSize = String(rawBase);

        const minFontSize = 4;
        const value = el.value ?? '';

        const maxByHeight = el instanceof HTMLTextAreaElement
            ? Math.max(minFontSize, availableH * 0.45)
            : Math.max(minFontSize, availableH * 0.72);

        let maxStartSize = maxByHeight;
        if (el instanceof HTMLTextAreaElement && value) {
            const explicitLineCount = Math.max(1, value.split(/\r\n|\r|\n/).length);
            const maxByLineCount = Math.max(minFontSize, (availableH / explicitLineCount) * 0.9);
            maxStartSize = Math.max(minFontSize, Math.min(maxStartSize, maxByLineCount));
        }

        maxStartSize = Math.max(minFontSize, Math.min(maxStartSize, Math.max(rawBase, minFontSize)));

        const fits = () => {
            if (el instanceof HTMLTextAreaElement) {
                return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
            }
            return this.singleLineInputFits(el, value);
        };

        if (!value) {
            el.style.setProperty('font-size', `${maxStartSize}px`, 'important');
            return;
        }

        let low = minFontSize;
        let high = Math.max(minFontSize, maxStartSize);
        let best = minFontSize;

        el.style.setProperty('font-size', `${high}px`, 'important');
        if (fits()) {
            return;
        }

        el.style.setProperty('font-size', `${low}px`, 'important');
        if (!fits()) {
            return;
        }

        for (let i = 0; i < 12; i++) {
            const mid = (low + high) / 2;
            el.style.setProperty('font-size', `${mid}px`, 'important');
            if (fits()) {
                best = mid;
                low = mid;
            } else {
                high = mid;
            }
        }

        el.style.setProperty('font-size', `${best}px`, 'important');
    }

    private getTextMeasureContext() {
        if (this.textMeasureCtx) return this.textMeasureCtx;
        const canvas = document.createElement('canvas');
        this.textMeasureCtx = canvas.getContext('2d');
        return this.textMeasureCtx;
    }

    private singleLineInputFits(el: HTMLInputElement, value: string) {
        const ctx = this.getTextMeasureContext();
        if (!ctx) {
            return el.scrollWidth <= el.clientWidth + 1;
        }

        const style = window.getComputedStyle(el);
        const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const availableTextWidth = Math.max(0, el.clientWidth - paddingX - 2);
        if (availableTextWidth <= 1) return false;

        const fontStyle = style.fontStyle || 'normal';
        const fontVariant = style.fontVariant || 'normal';
        const fontWeight = style.fontWeight || '400';
        const fontSize = style.fontSize || '12px';
        const fontFamily = style.fontFamily || 'sans-serif';
        ctx.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;

        const text = value || '';
        let width = ctx.measureText(text).width;

        const letterSpacing = parseFloat(style.letterSpacing);
        if (Number.isFinite(letterSpacing) && text.length > 1) {
            width += letterSpacing * (text.length - 1);
        }

        return width <= availableTextWidth + 0.5;
    }

    // --- Dirty tracking ---

    markDirty(child: PDFViewerChild) {
        const state = this.getState(child);
        if (state.disposed) return;
        const wasDirty = state.dirty;
        state.dirty = true;

        if (!wasDirty) {
            this.preloadPdfDoc(child);
        }

        // Always notify so the UI indicator stays in sync even across viewer reloads.
        this.notifyListeners(child, 0);

        if (!this.isAutoSaveEnabled()) return;
        this.scheduleAutoSave(child, this.getAutoSaveDebounceMs());
    }

    // --- Form detection ---

    async hasForms(child: PDFViewerChild): Promise<boolean> {
        let doc = child.pdfViewer.pdfViewer?.pdfDocument as PDFDocumentLike | null | undefined;
        if (!doc) {
            doc = await this.waitForPdfDocument(child);
        }

        const getFieldObjects = doc?.getFieldObjects;
        if (typeof getFieldObjects === 'function') {
            try {
                const fieldObjects = await getFieldObjects.call(doc);
                if (isRecord(fieldObjects) && Object.keys(fieldObjects).length > 0) return true;
            } catch {
                // ignore
            }
        }

        if (child.pdfViewer.dom?.viewerEl?.querySelector('.annotationLayer input, .annotationLayer textarea, .annotationLayer select')) {
            return true;
        }

        return !doc;
    }

    private getAnnotationStorage(child: PDFViewerChild): any | null {
        const viewerStorage = (child.pdfViewer.pdfViewer as any)?.annotationStorage;
        if (viewerStorage) return viewerStorage;

        const pages = child.pdfViewer.pdfViewer?._pages;
        if (Array.isArray(pages)) {
            for (const pageView of pages) {
                const storage = pageView?.annotationLayer?.annotationStorage;
                if (storage) return storage;
            }
        }
        return null;
    }

    private async flushPendingActiveFormEdit(child: PDFViewerChild) {
        const viewerContainerEl = child.pdfViewer?.dom?.viewerContainerEl;
        if (!viewerContainerEl) return;
        const doc = viewerContainerEl.doc ?? viewerContainerEl.ownerDocument;
        const activeEl = doc?.activeElement;
        if (!(activeEl instanceof HTMLElement)) return;
        if (!viewerContainerEl.contains(activeEl)) return;
        if (!activeEl.closest('.annotationLayer')) return;
        if (!activeEl.matches('input, textarea, select')) return;

        // Some PDFs update annotation storage only after commit/blur.
        activeEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof (activeEl as any).blur === 'function') {
            (activeEl as any).blur();
        }

        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }

    async collectFormState(child: PDFViewerChild): Promise<CollectedPdfFormState> {
        const fields = new Map<string, CollectedPdfFormFieldState>();

        const doc = child.pdfViewer.pdfViewer?.pdfDocument;
        if (!doc) return { hasForms: false, fields };

        const widgetIdToFieldName = new Map<string, { name: string; type: PdfFormFieldType }>();
        let hasForms = false;

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

                        if (Array.isArray(widgets)) {
                            for (const w of widgets) {
                                const id = w?.id;
                                if ((typeof id === 'string' || typeof id === 'number') && id !== '') {
                                    widgetIdToFieldName.set(String(id), { name: fieldName, type });
                                }
                            }
                        }
                    }
                }
            } catch {
                // ignore
            }
        }

        const annotationStorage = this.getAnnotationStorage(child);
        if (annotationStorage) {
            const all =
                typeof annotationStorage.getAll === 'function'
                    ? await annotationStorage.getAll()
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
        if (code === 'Tx') return 'text';
        if (code === 'Ch') {
            const isCombo = !!fieldObject?.combo;
            return isCombo ? 'dropdown' : 'option-list';
        }
        if (code === 'Sig') return 'unknown';
        if (code === 'Btn') {
            if (fieldObject?.radioButton) return 'radio';
            if (fieldObject?.checkBox) return 'checkbox';
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
        if (el.multiple) {
            return { type: 'option-list', value: Array.from(el.selectedOptions).map((o) => o.value) };
        }
        return { type: 'dropdown', value: el.value ?? '' };
    }

    // --- Form locking (prevent edits during save) ---

    private setFormFieldsLocked(child: PDFViewerChild, locked: boolean) {
        const viewerEl = child.pdfViewer?.dom?.viewerEl;
        if (!viewerEl) return;

        const controls = viewerEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            '.annotationLayer input, .annotationLayer textarea, .annotationLayer select',
        );
        for (const el of controls) {
            if (locked) {
                if (!el.hasAttribute('data-pdf-plus-was-disabled')) {
                    el.setAttribute('data-pdf-plus-was-disabled', el.disabled ? 'true' : 'false');
                }
                el.disabled = true;
            } else {
                const wasDisabled = el.getAttribute('data-pdf-plus-was-disabled');
                if (wasDisabled !== null) {
                    el.disabled = wasDisabled === 'true';
                    el.removeAttribute('data-pdf-plus-was-disabled');
                }
            }
        }
    }

    // --- Save pipeline ---

    async saveFormFields(child: PDFViewerChild, options?: { silent?: boolean }): Promise<boolean> {
        const silent = options?.silent ?? false;
        const state = this.getState(child);
        if (!this.isChildUsableForSave(child, state)) return false;

        if (!this.isEnabled()) {
            if (!silent) {
                new Notice(`${this.plugin.manifest.name}: Enable PDF editing to save form fields.`);
            }
            return false;
        }

        if (!this.lib.isEditable(child)) {
            if (!silent) {
                new Notice(`${this.plugin.manifest.name}: This PDF cannot be edited (e.g. external file or PDF editing disabled).`);
            }
            return false;
        }

        const file = child.file;
        if (!(file instanceof TFile)) return false;

        if (!silent && state.timerId !== null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }
        if (state.inFlight) {
            state.queued = true;
            state.queuedSilent = state.queuedSilent && silent;
            if (!silent) {
                new Notice(`${this.plugin.manifest.name}: Save queued...`);
            }
            return true;
        }

        state.inFlight = true;
        this.notifyListeners(child, 0);

        try {
            const sourceFreshness = this.getFileFreshness(file);

            // Phase 1: Collect form state (re-collect as late as possible to capture recent edits)
            this.notifyListeners(child, 5);
            await this.flushPendingActiveFormEdit(child);
            const collected = await this.collectFormState(child);
            if (!collected.hasForms) {
                if (!silent) {
                    new Notice(`${this.plugin.manifest.name}: No form fields found in this PDF.`);
                }
                this.notifyListeners(child, 0);
                return false;
            }
            if (collected.fields.size === 0) {
                if (!silent) {
                    new Notice(`${this.plugin.manifest.name}: Could not read form field values from the current viewer state. Try again after the page finishes rendering.`);
                }
                this.notifyListeners(child, 0);
                return false;
            }

            // Lock form fields so the user can't edit during the write cycle.
            this.setFormFieldsLocked(child, true);

            // Phase 2: Load PDF document (or use cache)
            this.notifyListeners(child, 15);
            const pdfDoc = await this.getOrLoadPdfDoc(file);

            // Phase 3: Apply form values
            this.notifyListeners(child, 35);
            await this.applyFormStateToPdfLibDocument(pdfDoc, collected.fields);

            // Phase 4: Serialize PDF
            this.notifyListeners(child, 55);
            const buffer = await pdfDoc.save();

            // Phase 5: Write to vault
            this.notifyListeners(child, 80);
            const preWriteFreshness = this.getFileFreshness(file);
            if (!this.isFreshnessEqual(preWriteFreshness, sourceFreshness)) {
                this.invalidatePdfDocCache(file.path);
                state.dirty = true;
                this.notifyListeners(child, 0);
                new Notice(`${this.plugin.manifest.name}: The PDF changed before form save completed. Save aborted to avoid overwriting newer content.`);
                return false;
            }
            await this.app.vault.modifyBinary(file, buffer);

            // Cache the PDFDocument for next save
            const latest = this.app.vault.getAbstractFileByPath(file.path);
            if (latest instanceof TFile) {
                this.cachePdfDoc(latest, pdfDoc);
            } else {
                this.invalidatePdfDocCache(file.path);
            }

            state.dirty = false;
            this.notifyListeners(child, 100);
            if (!silent) {
                new Notice(`${this.plugin.manifest.name}: Saved PDF form fields.`);
            }
            return true;
        } finally {
            this.setFormFieldsLocked(child, false);
            state.inFlight = false;
            const shouldRunAgain = state.queued;
            const queuedSilent = state.queuedSilent;
            state.queued = false;
            state.queuedSilent = true;
            this.notifyListeners(child, 0);
            if (shouldRunAgain && this.isChildUsableForSave(child, state)) {
                this.saveFormFields(child, { silent: queuedSilent }).catch((e) => console.error(e));
            }
        }
    }

    onChildUnload(child: PDFViewerChild) {
        const state = this.getState(child);
        state.disposed = true;
        if (state.timerId !== null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }
        state.queued = false;
        state.queuedSilent = true;

        this.stateListeners.delete(child);
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
