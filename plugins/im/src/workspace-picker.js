import React from 'react';
import {Modal} from '@deepseek-ai/dsh-client-ui-primitives';

const h = React.createElement;

/**
 * Browse Host directories through `uiWorkspace`, the service behind the
 * native Select Workspace Directory dialog. That dialog is internal to its
 * package, so this follows dsh-im's own picker on the same primitives.
 * Absent `uiWorkspace` leaves `available()` false and the caller keeps a text field.
 */
export function workspaceDirectories(ctx) {
  const service = () => typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
  const call = (method, ...args) => {
    const target = service();
    if (typeof target?.[method] !== 'function') throw new Error('uiWorkspace is unavailable');
    return target[method](...args);
  };
  return Object.freeze({
    available: () => typeof service()?.listDirectory === 'function',
    listDirectory: (path, signal) => call('listDirectory', path, signal),
    createDirectory: (path, name) => call('createDirectory', path, name),
  });
}

const ERRORS = {'directory-picker/unreadable': 'directoryUnreadable', 'directory-picker/exists': 'directoryExists', 'directory-picker/create-failed': 'directoryCreateFailed'};
const failure = (error, t, fallback) => t(ERRORS[error?.rpcError?.code ?? error?.code] ?? fallback);

function FolderIcon() {
  return h('svg', {viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true},
    h('path', {d: 'M3.5 7.25A2.25 2.25 0 0 1 5.75 5h4.1l1.8 2h6.6a2.25 2.25 0 0 1 2.25 2.25v7A2.75 2.75 0 0 1 17.75 19h-12A2.25 2.25 0 0 1 3.5 16.75v-9.5Z'}));
}
function ChevronIcon() {
  return h('svg', {viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true}, h('path', {d: 'm7.5 4.5 5 5.5-5 5.5'}));
}

/** The current workspace with a button that opens the directory dialog; a pick edits the form draft. */
export function WorkspaceField({value, directories, disabled, onChange, t}) {
  const [open, setOpen] = React.useState(false);
  const button = React.useRef();
  const close = () => {setOpen(false); queueMicrotask(() => button.current?.focus());};
  return h('div', {className: 'dim-workspace'},
    h('div', {className: 'dim-workspaceHeader'}, h('span', null, t('workspace')),
      h('button', {type: 'button', ref: button, className: 'dim-workspaceEdit', disabled, onClick: () => setOpen(true)}, t('chooseDirectory'))),
    h('code', {className: 'dim-workspacePath', title: value}, value),
    open ? h(WorkspaceDirectoryPicker, {startPath: value, directories, t, onCancel: close, onPicked: path => {onChange(path); close();}}) : null);
}

function WorkspaceDirectoryPicker({startPath, directories, t, onPicked, onCancel}) {
  const [listing, setListing] = React.useState(null), [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(), [pathDraft, setPathDraft] = React.useState(startPath ?? '');
  const [showHidden, setShowHidden] = React.useState(false), [retry, setRetry] = React.useState(0);
  const [folder, setFolder] = React.useState(null), [creating, setCreating] = React.useState(false);
  const request = React.useRef(0), controller = React.useRef(), body = React.useRef();
  const ids = {title: React.useId(), notice: React.useId(), path: React.useId(), error: React.useId(), folder: React.useId()};

  const load = React.useCallback(async (path, report = true) => {
    const current = ++request.current;
    controller.current?.abort();
    const abort = controller.current = new AbortController();
    setLoading(true);
    if (report) setError(undefined);
    try {
      const next = await directories.listDirectory(path, abort.signal);
      if (current !== request.current) return {aborted: true};
      if (body.current) body.current.scrollTop = 0;
      setListing(next); setPathDraft(next.path); setError(undefined);
      return {value: next};
    } catch (cause) {
      if (current !== request.current) return {aborted: true};
      if (report) setError(failure(cause, t, 'directoryFailed'));
      return {error: cause};
    } finally {if (current === request.current) setLoading(false);}
  }, [directories, t]);

  React.useEffect(() => {
    let active = true;
    // An unreadable saved workspace falls back to the Host home so the dialog stays usable.
    void (async () => {
      const initial = await load(startPath || undefined, false);
      if (!active || initial.aborted || initial.value) return;
      if (startPath && (initial.error?.rpcError?.code ?? initial.error?.code) === 'directory-picker/unreadable') {
        const home = await load(undefined, false);
        if (!active || home.aborted || home.value) return;
        setError(failure(home.error, t, 'directoryFailed'));
      } else setError(failure(initial.error, t, 'directoryFailed'));
    })();
    return () => {active = false; request.current++; controller.current?.abort();};
  }, [load, retry]);

  const create = async event => {
    event.preventDefault();
    const name = folder?.trim();
    if (!listing || !name || creating) return;
    setCreating(true); setError(undefined);
    try {const path = await directories.createDirectory(listing.path, name); setFolder(null); await load(path);}
    catch (cause) {setError(failure(cause, t, 'directoryCreateFailed'));}
    finally {setCreating(false);}
  };

  const entries = (listing?.entries ?? []).filter(entry => showHidden || !entry.hidden);
  const home = listing ? Math.max(0, listing.crumbs.findIndex(crumb => crumb.path === listing.home)) : 0;
  const crumbs = listing ? listing.crumbs.slice(home) : [];
  const ready = listing !== null && pathDraft === listing.path && !loading && folder === null;
  const inert = loading || creating;
  return h(Modal, {open: true, headless: true, title: t('directoryTitle'), className: 'dim-directoryPicker', onClose: () => {if (folder === null && !creating) onCancel();}},
    // The folder name editor owns Escape while it is open; the Modal's document listener never sees it.
    h('div', {className: 'dim-directoryPickerScope', onKeyDown: event => {if (event.key === 'Escape' && folder !== null) {event.stopPropagation(); setFolder(null);}}},
      h('header', {className: 'dim-directoryPickerHeader'},
        h('h3', {id: ids.title}, t('directoryTitle')),
        listing ? h('nav', {className: 'dim-directoryCrumbs', 'aria-label': t('directoryCrumbs')}, crumbs.map((crumb, index) => h(React.Fragment, {key: crumb.path},
          index > 0 ? h('span', {className: 'dim-directoryCrumbSeparator', 'aria-hidden': true}, '›') : null,
          h('button', {type: 'button', title: crumb.path, disabled: inert, 'aria-current': index === crumbs.length - 1 ? 'page' : undefined, onClick: () => void load(crumb.path)},
            crumb.path === listing.home ? t('directoryHome') : crumb.name || crumb.path)))) : h('p', null, t('directoryLoading')),
        h('form', {className: 'dim-directoryPathForm', onSubmit: event => {event.preventDefault(); if (!inert && pathDraft.trim()) void load(pathDraft.trim());}},
          h('div', {className: 'dim-directoryPathMeta'}, h('label', {htmlFor: ids.path}, t('directoryPath')), h('span', null, t('directoryPathHint'))),
          h('div', {className: 'dim-directoryPathControl'},
            h('input', {id: ids.path, className: 'dim-directoryPathInput', value: pathDraft, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, maxLength: 4096, disabled: inert,
              'aria-invalid': error ? 'true' : undefined, 'aria-describedby': error ? ids.error : undefined, onChange: event => {setPathDraft(event.target.value); setError(undefined);}}),
            h('button', {type: 'submit', disabled: inert || !pathDraft.trim()}, t(loading ? 'directoryReading' : 'directoryGo'))))),
      h('div', {ref: body, className: 'dim-directoryPickerBody', 'aria-busy': loading},
        loading && !listing ? h('div', {className: 'dim-directoryPickerState'}, h('span', {className: 'dim-directoryPickerSpinner', 'aria-hidden': true}), h('p', null, t('directoryLoading')))
          : listing ? entries.length ? h('ul', {className: 'dim-directoryList'}, entries.map(entry => h('li', {key: entry.path},
            h('button', {type: 'button', title: entry.path, disabled: inert, onClick: () => void load(entry.path)},
              h('span', {className: 'dim-directoryFolder'}, h(FolderIcon)), h('span', {className: 'dim-directoryName'}, entry.name), h('span', {className: 'dim-directoryChevron'}, h(ChevronIcon))))))
            : h('div', {className: 'dim-directoryPickerState'}, h('p', null, t('directoryEmpty'))) : null,
        listing?.truncated ? h('p', {className: 'dim-directoryPickerTruncated'}, t('directoryTruncated')) : null,
        error ? h('div', {id: ids.error, className: 'dim-directoryPickerError', role: 'alert'}, h('span', null, error),
          !listing ? h('button', {type: 'button', onClick: () => setRetry(value => value + 1)}, t('directoryRetry')) : null) : null),
      folder !== null ? h('form', {className: 'dim-directoryFolderForm', onSubmit: create},
        h('label', {htmlFor: ids.folder}, t('folderName')),
        h('input', {id: ids.folder, className: 'dim-directoryPathInput', value: folder, autoFocus: true, maxLength: 255, disabled: creating, onChange: event => {setFolder(event.target.value); setError(undefined);}}),
        h('div', {className: 'dim-directoryPickerActions'},
          h('button', {type: 'button', disabled: creating, onClick: () => setFolder(null)}, t('cancel')),
          h('button', {type: 'submit', className: 'dim-directoryPickerPrimary', disabled: creating || !folder.trim()}, t('createFolder')))) : null,
      h('footer', {className: 'dim-directoryPickerFooter'},
        h('div', {className: 'dim-directoryTools'},
          h('button', {type: 'button', className: 'dim-directoryHidden', 'aria-pressed': showHidden, disabled: !listing, onClick: () => setShowHidden(value => !value)},
            h('span', {className: 'dim-directoryHiddenBox', 'aria-hidden': true}), h('span', null, t('directoryHidden'))),
          h('button', {type: 'button', className: 'dim-directoryNewFolder', disabled: !listing || inert || folder !== null, onClick: () => setFolder('')}, t('newFolder'))),
        h('p', {id: ids.notice, className: 'dim-directoryPickerNotice'}, t('directoryNotice')),
        h('div', {className: 'dim-directoryPickerActions'},
          h('button', {type: 'button', disabled: creating, onClick: onCancel}, t('cancel')),
          h('button', {type: 'button', className: 'dim-directoryPickerPrimary', disabled: !ready, onClick: () => onPicked(listing.path)}, t('directorySelect'))))));
}
