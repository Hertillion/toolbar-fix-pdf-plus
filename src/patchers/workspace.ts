import { OpenViewState, PaneType, TFile, Workspace, WorkspaceLeaf, parseLinktext, Platform } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { focusObsidian } from 'utils';


export const patchWorkspace = (plugin: PDFPlus) => {
    const app = plugin.app;
    const lib = plugin.lib;
    const pendingUnsavedGuardByLeaf = new WeakMap<WorkspaceLeaf, Promise<boolean>>();

    const guardUnsavedPdfFormChanges = async (leaf: WorkspaceLeaf, nextFilePath?: string | null) => {
        const view = leaf.view;
        if (!view || !lib.isPDFView(view)) return true;
        const child = view.viewer?.child;
        if (!child || !(child.file instanceof TFile)) return true;

        if (nextFilePath && child.file.path === nextFilePath) {
            return true;
        }
        return lib.forms.handlePendingFormChangesBeforeClose(child);
    };
    const guardUnsavedPdfFormChangesOnce = async (leaf: WorkspaceLeaf, nextFilePath?: string | null) => {
        const existing = pendingUnsavedGuardByLeaf.get(leaf);
        if (existing) return existing;
        const promise = guardUnsavedPdfFormChanges(leaf, nextFilePath).finally(() => {
            pendingUnsavedGuardByLeaf.delete(leaf);
        });
        pendingUnsavedGuardByLeaf.set(leaf, promise);
        return promise;
    };
    const runWithUnsavedPdfFormGuard = async (
        leaf: WorkspaceLeaf,
        nextFilePath: string | null,
        run: () => any,
    ) => {
        const proceed = await guardUnsavedPdfFormChangesOnce(leaf, nextFilePath);
        if (!proceed) return;
        return run();
    };

    plugin.register(around(Workspace.prototype, {
        openLinkText(old) {
            return function (linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: OpenViewState) {
                if ((plugin.settings.openPDFWithDefaultApp || plugin.settings.singleTabForSinglePDF || plugin.settings.openLinkNextToExistingPDFTab || plugin.settings.paneTypeForFirstPDFLeaf) && !newLeaf) { // respect `newLeaf` when it's not `false`
                    const { path } = parseLinktext(linktext);
                    const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);

                    if (file && file.extension === 'pdf') {

                        if (Platform.isDesktopApp && plugin.settings.openPDFWithDefaultApp) {
                            if (plugin.settings.openPDFWithDefaultAppAndObsidian && plugin.settings.syncWithDefaultApp) {
                                return; // will be handled by the 'active-leaf-change' event handler
                            }
                            const promise = app.openWithDefaultApp(file.path);
                            if (plugin.settings.focusObsidianAfterOpenPDFWithDefaultApp) {
                                focusObsidian();
                            }
                            if (!plugin.settings.openPDFWithDefaultAppAndObsidian) {
                                return promise;
                            }
                        }

                        if (plugin.settings.singleTabForSinglePDF) {
                            const { exists, promise } = lib.workspace.openPDFLinkTextInExistingLeafForTargetPDF(linktext, sourcePath, openViewState, file);
                            if (exists) return promise;
                        }

                        if (plugin.settings.openLinkNextToExistingPDFTab || plugin.settings.paneTypeForFirstPDFLeaf) {
                            const pdfLeaf = lib.getPDFView()?.leaf;
                            if (pdfLeaf) {
                                if (plugin.settings.openLinkNextToExistingPDFTab && pdfLeaf.parentSplit) {
                                    const newLeaf = app.workspace.createLeafInParent(pdfLeaf.parentSplit, -1);
                                    return lib.workspace.openPDFLinkTextInLeaf(newLeaf, linktext, sourcePath, openViewState);
                                }
                            } else if (plugin.settings.paneTypeForFirstPDFLeaf) {
                                const newLeaf = lib.workspace.getLeaf(plugin.settings.paneTypeForFirstPDFLeaf);
                                return lib.workspace.openPDFLinkTextInLeaf(newLeaf, linktext, sourcePath, openViewState);
                            }
                        }
                    }
                }

                return old.call(this, linktext, sourcePath, newLeaf, openViewState);
            };
        }
    }));

    // Intercept leaf file-open to guard unsaved PDF form edits.
    plugin.register(around(WorkspaceLeaf.prototype, {
        openFile(old) {
            return async function (this: WorkspaceLeaf, file: TFile, openState?: any) {
                return runWithUnsavedPdfFormGuard(this, file.path, () => old.call(this, file, openState));
            };
        },
        setViewState(old) {
            return async function (this: WorkspaceLeaf, viewState: any, eState?: any) {
                const currentView = this.view;
                const isCurrentPdf = !!currentView && lib.isPDFView(currentView);
                if (isCurrentPdf) {
                    const nextType = viewState?.type;
                    const nextFilePath = typeof viewState?.state?.file === 'string' ? viewState.state.file : null;
                    // Guard transitions that leave the currently opened PDF, including tab close.
                    if (nextType !== 'pdf' || !nextFilePath || currentView.file?.path !== nextFilePath) {
                        return runWithUnsavedPdfFormGuard(this, nextFilePath, () => old.call(this, viewState, eState));
                    }
                }
                return old.call(this, viewState, eState);
            };
        },
        detach(old) {
            return async function (this: WorkspaceLeaf, ...args: any[]) {
                return runWithUnsavedPdfFormGuard(this, null, () => old.apply(this, args));
            };
        },
    }));

    plugin.patchStatus.workspace = true;
};
