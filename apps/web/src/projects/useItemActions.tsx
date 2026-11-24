import { can, type PriorityLabel, type Project, type ProjectList, type ProjectStatus, type Role } from '@roadmap/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { CALENDAR_DOWNLOAD_FAILED, errorCode, itemActionMessage } from '../api/errors.ts';
import type { useMembers } from '../members/useMembers.ts';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import type { MenuItem } from '../ui/Menu.tsx';
import { downloadItemCalendar, hasCalendarDates } from './calendarFile.ts';
import type { OwnChange } from './ProjectPanel.tsx';
import { titleLinkId } from './itemParts.tsx';
import {
  isAssigned,
  PROJECTS_KEY,
  useArchive,
  useDeleteProject,
  useReorder,
  useSetAssignees,
  useSetPriorityLabel,
  useUnarchive,
  useUpdateProject,
  type useProjects,
} from './useProjects.ts';

export interface ItemActions {
  actionError: string | undefined;
  notice: string;
  setNotice: (text: string) => void;
  ownChange: OwnChange | undefined;
  /** Resolves true once saved; false when refused, or when the item already has that status. */
  changeStatus: (item: Project, status: ProjectStatus) => Promise<boolean>;
  toggleAssignee: (itemId: string, userId: string, assigned: boolean) => void;
  changePriorityLabel: (itemId: string, label: PriorityLabel | null) => void;
  reorderItems: (parentId: string | null, orderedIds: string[], announce?: string) => void;
  archiveItem: (item: Project) => void;
  unarchiveItem: (item: Project) => void;
  askDelete: (item: Project) => void;
  /** Downloads the item's dates as a calendar file; a failure shows in `actionError` (FR-4.5). */
  addToCalendar: (item: Project) => void;
  openItem: (itemId: string) => void;
  closePanel: () => void;
  /** Runs `action` now, or after the person agrees to discard unsaved panel edits. */
  unlessDirty: (action: () => void) => void;
  onDirtyChange: (dirty: boolean) => void;
  reloadItem: () => Promise<Project | undefined>;
  /**
   * "Open", "Add to calendar" for an item with a date or a milestone, then "Archive" or "Unarchive" and "Delete" when
   * the person may delete the item.
   */
  menuFor: (item: Project) => MenuItem[];
  /** The Delete and Discard dialogs. The page renders this once. */
  dialogs: ReactNode;
  /** Put on the page's h1: focus goes there when the item that held it is gone. */
  headingRef: RefObject<HTMLHeadingElement | null>;
}

/** Every action on an item that a view offers, with the state they share: errors, notices, the panel and its dialogs. */
export function useItemActions(opts: {
  roadmapId: string;
  role: Role;
  myId: string | undefined;
  /** The view's own address, such as `/r/abc/projects`; an item opens at `${basePath}/${id}`. */
  basePath: string;
  /** The query string to keep, with its leading "?" or empty. */
  search: string;
  projectId: string | undefined;
  projects: ReturnType<typeof useProjects>;
  members: ReturnType<typeof useMembers>;
}): ItemActions {
  const { roadmapId, role, myId, basePath, search, projectId, projects, members } = opts;
  const navigate = useNavigate();
  const update = useUpdateProject(roadmapId);
  const setAssignees = useSetAssignees(roadmapId);
  const setPriorityLabel = useSetPriorityLabel(roadmapId);
  const reorder = useReorder(roadmapId);
  const archive = useArchive(roadmapId);
  const unarchive = useUnarchive(roadmapId);
  const deleteItem = useDeleteProject(roadmapId);
  const queryClient = useQueryClient();
  // The message for the last failed action from a row or from a panel control that saves on change.
  const [actionError, setActionError] = useState<string | undefined>();
  // What the last archive or unarchive did, in a live region.
  const [notice, setNotice] = useState('');
  // The item the Delete dialog is open for, and why the last attempt failed.
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  // Counts up when focus should go to the page heading, because the item that held it is gone.
  const [headingFocus, setHeadingFocus] = useState(0);
  // The latest save made outside the panel's form (status pill, assignees, priority label), which the open panel
  // adopts so its own Save does not conflict with it.
  const [ownChange, setOwnChange] = useState<OwnChange>();
  // Whether the open panel has unsaved edits, and what to do once the person agrees to discard them.
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => void (dirty.current = value), []);
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  // Saves made outside the panel's form run one after another, each starting from the newest saved state of its item.
  const statusQueue = useRef<Promise<void>>(Promise.resolve());
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set when the panel is closed on purpose: once the view is back in sight, focus returns to that item's title.
  const returnFocusTo = useRef<string | null>(null);

  useEffect(() => {
    if (headingFocus > 0) headingRef.current?.focus();
  }, [headingFocus]);

  const selected = projectId ? projects.byId.get(projectId) : undefined;
  // Where closing the panel goes back to: the view as it was filtered.
  const viewUrl = `${basePath}${search}`;
  const hasPanel = projectId !== undefined;

  /** Runs `action` now, or after the person agrees to discard unsaved edits in the panel. */
  const unlessDirty = (action: () => void) => {
    if (dirty.current) setPendingDiscard(() => action);
    else action();
  };
  const closePanel = () =>
    unlessDirty(() => {
      returnFocusTo.current = projectId ?? null;
      void navigate(viewUrl);
    });
  const openItem = (itemId: string) => {
    if (itemId === projectId) return;
    unlessDirty(() => void navigate(`${basePath}/${encodeURIComponent(itemId)}${search}`));
  };
  useEffect(() => {
    if (hasPanel || returnFocusTo.current === null) return;
    // The row's title if it is still in the view, otherwise the page heading.
    (document.getElementById(titleLinkId(returnFocusTo.current)) ?? headingRef.current)?.focus();
    returnFocusTo.current = null;
  }, [hasPanel]);

  /**
   * The message for a failed row or panel action. The list is refetched, so a row someone else deleted, or one the
   * person can no longer change, shows as it now is; a refused assignee also refetches the members.
   */
  const recoverFrom = async (err: unknown): Promise<string> => {
    if (errorCode(err) === 'not_a_member') void members.refetch();
    await projects.refetch();
    return itemActionMessage(err);
  };
  const failAction = (err: unknown) => void recoverFrom(err).then(setActionError);

  /**
   * Runs one of this browser's own saves for an item after the ones before it, from the item as the list last
   * saw it, and tells the open panel about it. `save` gives back nothing when there is nothing to change.
   * Resolves true when the save went through, false when it was refused or there was nothing to change.
   */
  const runOwnChange = (itemId: string, save: (current: Project) => Promise<Project> | undefined, status = false): Promise<boolean> => {
    const run = statusQueue.current.then(async (): Promise<boolean> => {
      const current = queryClient.getQueryData<ProjectList>(PROJECTS_KEY(roadmapId))?.items.find((i) => i.id === itemId);
      if (!current) return false;
      try {
        const saved = await save(current);
        if (!saved) return false;
        setActionError(undefined);
        setOwnChange((last) => ({ id: saved.id, version: saved.version, ...(status && { status: saved.status }), n: (last?.n ?? 0) + 1 }));
        return true;
      } catch (err) {
        // Awaited, so the next queued save starts from what the server now holds.
        setActionError(await recoverFrom(err));
        return false;
      }
    });
    statusQueue.current = run.then(() => undefined);
    return run;
  };

  const changeStatus = (item: Project, status: ProjectStatus) =>
    runOwnChange(
      item.id,
      (current) => (status === current.status ? undefined : update.mutateAsync({ projectId: item.id, body: { version: current.version, status } })),
      true,
    );

  const toggleAssignee = (itemId: string, userId: string, assigned: boolean) =>
    void runOwnChange(itemId, (current) => {
      const ids = current.assigneeIds.filter((id) => id !== userId);
      if (assigned) ids.push(userId);
      return ids.length === current.assigneeIds.length && ids.every((id) => current.assigneeIds.includes(id))
        ? undefined
        : setAssignees.mutateAsync({ projectId: itemId, body: { userIds: ids, version: current.version } });
    });

  const changePriorityLabel = (itemId: string, label: PriorityLabel | null) =>
    void runOwnChange(itemId, (current) => (current.priorityLabel === label ? undefined : setPriorityLabel.mutateAsync({ projectId: itemId, label })));

  const reorderItems = (parentId: string | null, orderedIds: string[], announce?: string) => {
    setNotice('');
    setActionError(undefined);
    reorder.mutate({ parentId, orderedIds }, { onSuccess: () => announce && setNotice(announce), onError: failAction });
  };

  /** Whether the open panel is for `item` or something under it, so it goes when `item` does. */
  const panelIsUnder = (item: Project) => selected !== undefined && (selected.id === item.id || selected.path.includes(item.id));
  /** Runs `action` now, or after the person agrees to discard unsaved edits in the panel `item` takes with it. */
  const unlessDirtyUnder = (item: Project, action: () => void) => (panelIsUnder(item) ? unlessDirty(action) : action());
  const leavePanelOf = (item: Project) => {
    if (panelIsUnder(item)) void navigate(viewUrl);
    setHeadingFocus((n) => n + 1);
  };

  const archiveItem = (item: Project) =>
    unlessDirtyUnder(item, () => {
      setActionError(undefined);
      archive.mutate(item.id, {
        onSuccess: () => {
          setNotice(`Archived ${item.title}.`);
          leavePanelOf(item);
        },
        onError: failAction,
      });
    });

  const unarchiveItem = (item: Project) => {
    setActionError(undefined);
    unarchive.mutate(item.id, {
      onSuccess: () => setNotice(`Unarchived ${item.title}.`),
      onError: failAction,
    });
  };

  const askDelete = (item: Project) =>
    unlessDirtyUnder(item, () => {
      setDeleteError(undefined);
      setDeleting(item);
    });
  const confirmDelete = () => {
    const item = deleting;
    if (!item) return;
    deleteItem.mutate(item.id, {
      onSuccess: () => {
        setDeleting(null);
        setNotice('');
        leavePanelOf(item);
      },
      onError: (err) => void recoverFrom(err).then(setDeleteError),
    });
  };
  const underDeleting = deleting ? projects.items.filter((i) => i.path.includes(deleting.id)).length : 0;

  const addToCalendar = (item: Project) => {
    setActionError(undefined);
    downloadItemCalendar(roadmapId, item).catch(() => setActionError(CALENDAR_DOWNLOAD_FAILED));
  };

  const reloadItem = async (): Promise<Project | undefined> => {
    const fresh = await projects.refetch({ throwOnError: true });
    return fresh.data?.items.find((i) => i.id === projectId);
  };

  const menuFor = (item: Project): MenuItem[] => {
    const entries: MenuItem[] = [{ label: 'Open', onSelect: () => openItem(item.id) }];
    if (hasCalendarDates(item)) entries.push({ label: 'Add to calendar', onSelect: () => addToCalendar(item) });
    if (can({ role, action: 'project.delete', ctx: { isAssigned: isAssigned(item, myId, projects.byId) } })) {
      entries.push(
        item.archived ? { label: 'Unarchive', onSelect: () => unarchiveItem(item) } : { label: 'Archive', onSelect: () => archiveItem(item) },
        { label: 'Delete', onSelect: () => askDelete(item) },
      );
    }
    return entries;
  };

  const dialogs = (
    <>
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.title ?? 'this item'}?`}
        confirmLabel="Delete"
        error={deleteError}
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      >
        <p>{underDeleting > 0 ? `This also deletes the ${underDeleting} ${underDeleting === 1 ? 'item' : 'items'} under it. This can't be undone.` : "This can't be undone."}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={pendingDiscard !== null}
        title={`Discard your unsaved changes to ${selected?.title ?? 'this item'}?`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => {
          const action = pendingDiscard;
          setPendingDiscard(null);
          action?.();
        }}
        onClose={() => setPendingDiscard(null)}
      >
        {null}
      </ConfirmDialog>
    </>
  );

  return {
    actionError,
    notice,
    setNotice,
    ownChange,
    changeStatus,
    toggleAssignee,
    changePriorityLabel,
    reorderItems,
    archiveItem,
    unarchiveItem,
    askDelete,
    addToCalendar,
    openItem,
    closePanel,
    unlessDirty,
    onDirtyChange,
    reloadItem,
    menuFor,
    dialogs,
    headingRef,
  };
}
