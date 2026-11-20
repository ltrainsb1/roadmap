import { activeFilterCount, can, filterProjects, type PriorityLabel, type Project, type ProjectList, type ProjectStatus } from '@roadmap/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { errorCode, messageFor } from '../api/errors.ts';
import { useMe } from '../auth/useMe.ts';
import { useMembers } from '../members/useMembers.ts';
import { ROADMAP_NOT_FOUND, useRoadmap } from '../roadmaps/RoadmapLayout.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Field } from '../ui/Field.tsx';
import { FILTERS_PANEL_ID, FiltersPanel } from './FiltersPanel.tsx';
import { filtersFromSearch, filtersToSearch, hasNarrowing, ME } from './filters.ts';
import {
  actionsButtonId,
  NEW_PROJECT_BUTTON_ID,
  ProjectTree,
  titleLinkId,
  useCollapsed,
  type AddTarget,
} from './ProjectTree.tsx';
import { ProjectPanel, type OwnChange } from './ProjectPanel.tsx';
import {
  isAssigned,
  PROJECTS_KEY,
  useArchive,
  useCreateProject,
  useDeleteProject,
  useProjects,
  useReorder,
  useSetAssignees,
  useSetPriorityLabel,
  useUnarchive,
  useUpdateProject,
} from './useProjects.ts';

const NONE: ReadonlySet<string> = new Set();
const FILTERS_BUTTON_ID = 'filters-button';

export function ProjectsPage() {
  const { roadmapId, role } = useRoadmap();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const projects = useProjects(roadmapId);
  const members = useMembers(roadmapId);
  const create = useCreateProject(roadmapId);
  const update = useUpdateProject(roadmapId);
  const setAssignees = useSetAssignees(roadmapId);
  const setPriorityLabel = useSetPriorityLabel(roadmapId);
  const reorder = useReorder(roadmapId);
  const archive = useArchive(roadmapId);
  const unarchive = useUnarchive(roadmapId);
  const deleteItem = useDeleteProject(roadmapId);
  const queryClient = useQueryClient();
  const { collapsed, toggle, expand } = useCollapsed(roadmapId);
  // The filters live in the address, and nowhere else: opening an item keeps them, and a copied link shows the same list.
  const [params, setParams] = useSearchParams();
  const myId = me.data?.user.id;
  const filters = useMemo(() => filtersFromSearch(params), [params]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [adding, setAdding] = useState<AddTarget | null>(null);
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
  const heading = useRef<HTMLHeadingElement>(null);
  // Set when the panel is closed on purpose: once the list is back in view, focus returns to that item's title.
  const returnFocusTo = useRef<string | null>(null);

  useEffect(() => {
    if (headingFocus > 0) heading.current?.focus();
  }, [headingFocus]);

  const narrowing = hasNarrowing(filters);
  const filtered = narrowing || filters.showArchived;
  const view = useMemo(() => {
    if (!filtered) return { items: projects.items.filter((i) => !i.archived), context: NONE };
    // "Assigned to me" is the reader, whoever wrote the address.
    const mine = filters.assigneeIds.map((id) => (id === ME ? (myId ?? id) : id));
    const { matches, context } = filterProjects(projects.items, { ...filters, assigneeIds: mine });
    return { items: projects.items.filter((i) => matches.has(i.id) || context.has(i.id)), context };
  }, [filtered, filters, projects.items, myId]);
  const shown = view.items;
  const tagsInUse = useMemo(() => [...new Set(projects.items.filter((i) => !i.archived).flatMap((i) => i.tags))].sort(), [projects.items]);
  const search = params.toString() === '' ? '' : `?${params.toString()}`;
  const setFilters = (next: typeof filters) => setParams(filtersToSearch(next), { replace: true });
  const clearFilters = () => setParams(new URLSearchParams(), { replace: true });
  const closeFilters = () => {
    setFiltersOpen(false);
    document.getElementById(FILTERS_BUTTON_ID)?.focus();
  };
  const memberNames = useMemo(() => new Map((members.data?.members ?? []).map((m) => [m.userId, m.name])), [members.data]);
  const selected = projectId ? projects.byId.get(projectId) : undefined;

  const startAdd = useCallback(
    (parentId: string | null) => {
      if (parentId) expand(parentId);
      setAdding({ parentId });
    },
    [expand],
  );

  const cancelAdd = () => {
    const parentId = adding?.parentId;
    setAdding(null);
    // The add row held focus; hand it back to the control that opened it.
    document.getElementById(parentId ? actionsButtonId(parentId) : NEW_PROJECT_BUTTON_ID)?.focus();
  };

  const listPath = `/r/${encodeURIComponent(roadmapId)}/projects`;
  // Where closing the panel goes back to: the list as it was filtered.
  const listUrl = `${listPath}${search}`;
  const hasPanel = projectId !== undefined;

  /** Runs `action` now, or after the person agrees to discard unsaved edits in the panel. */
  const unlessDirty = (action: () => void) => {
    if (dirty.current) setPendingDiscard(() => action);
    else action();
  };
  const closePanel = () =>
    unlessDirty(() => {
      returnFocusTo.current = projectId ?? null;
      void navigate(listUrl);
    });
  const openItem = (itemId: string) => {
    if (itemId === projectId) return;
    unlessDirty(() => void navigate(`${listPath}/${encodeURIComponent(itemId)}${search}`));
  };
  useEffect(() => {
    if (hasPanel || returnFocusTo.current === null) return;
    // The row's title if it is still in the list, otherwise the page heading.
    (document.getElementById(titleLinkId(returnFocusTo.current)) ?? heading.current)?.focus();
    returnFocusTo.current = null;
  }, [hasPanel]);

  /**
   * Runs one of this browser's own saves for an item after the ones before it, from the item as the list last
   * saw it, and tells the open panel about it. `save` gives back nothing when there is nothing to change.
   */
  const runOwnChange = (itemId: string, save: (current: Project) => Promise<Project> | undefined, status = false) => {
    statusQueue.current = statusQueue.current.then(async () => {
      const current = queryClient.getQueryData<ProjectList>(PROJECTS_KEY(roadmapId))?.items.find((i) => i.id === itemId);
      if (!current) return;
      try {
        const saved = await save(current);
        if (!saved) return;
        setActionError(undefined);
        setOwnChange((last) => ({ id: saved.id, version: saved.version, ...(status && { status: saved.status }), n: (last?.n ?? 0) + 1 }));
      } catch (err) {
        setActionError(messageFor(err));
        // Someone else changed it first: the list shows what they saved.
        if (errorCode(err) === 'conflict') await projects.refetch();
      }
    });
  };

  const changeStatus = (item: Project, status: ProjectStatus) =>
    runOwnChange(
      item.id,
      (current) => (status === current.status ? undefined : update.mutateAsync({ projectId: item.id, body: { version: current.version, status } })),
      true,
    );

  const toggleAssignee = (itemId: string, userId: string, assigned: boolean) =>
    runOwnChange(itemId, (current) => {
      const ids = current.assigneeIds.filter((id) => id !== userId);
      if (assigned) ids.push(userId);
      return ids.length === current.assigneeIds.length && ids.every((id) => current.assigneeIds.includes(id))
        ? undefined
        : setAssignees.mutateAsync({ projectId: itemId, body: { userIds: ids, version: current.version } });
    });

  const changePriorityLabel = (itemId: string, label: PriorityLabel | null) =>
    runOwnChange(itemId, (current) => (current.priorityLabel === label ? undefined : setPriorityLabel.mutateAsync({ projectId: itemId, label })));

  const reorderItems = (parentId: string | null, orderedIds: string[]) => {
    setNotice('');
    setActionError(undefined);
    reorder.mutate({ parentId, orderedIds }, { onError: (err) => setActionError(messageFor(err)) });
  };

  /** Whether the open panel is for `item` or something under it, so it goes when `item` does. */
  const panelIsUnder = (item: Project) => selected !== undefined && (selected.id === item.id || selected.path.includes(item.id));
  /** Runs `action` now, or after the person agrees to discard unsaved edits in the panel `item` takes with it. */
  const unlessDirtyUnder = (item: Project, action: () => void) => (panelIsUnder(item) ? unlessDirty(action) : action());
  const leavePanelOf = (item: Project) => {
    if (panelIsUnder(item)) void navigate(listUrl);
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
        onError: (err) => setActionError(messageFor(err)),
      });
    });

  const unarchiveItem = (item: Project) => {
    setActionError(undefined);
    unarchive.mutate(item.id, {
      onSuccess: () => setNotice(`Unarchived ${item.title}.`),
      onError: (err) => setActionError(messageFor(err)),
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
      onError: (err) => setDeleteError(messageFor(err)),
    });
  };
  const underDeleting = deleting ? projects.items.filter((i) => i.path.includes(deleting.id)).length : 0;

  const reloadItem = async (): Promise<Project | undefined> => {
    const fresh = await projects.refetch({ throwOnError: true });
    return fresh.data?.items.find((i) => i.id === projectId);
  };

  const canAddTop = can({ role, action: 'project.create', ctx: { isAssigned: false } });
  // The list shows whenever its data is there: a failed refresh must not unmount the rows, an open add row or focus.
  // The members only name the assignees, so a slow or failed members list leaves the names out and nothing more.
  // It waits for the signed-in person too, so "Assigned to me" in the address always has someone to mean.
  const hasList = projects.data !== undefined && myId !== undefined;
  // Save is the primary button while an editable panel is open; otherwise "New project" is.
  const panelEditable =
    selected !== undefined && can({ role, action: 'project.edit', ctx: { isAssigned: isAssigned(selected, me.data?.user.id, projects.byId) } });
  const activeCount = activeFilterCount(filters);
  // A filtered list holds only part of a sibling group, and a reorder must send the whole group.
  const reorderable = !filtered;
  const canReorderRole = can({ role, action: 'project.setPriority' });
  const refreshFailed = hasList && projects.isRefetchError;

  return (
    <>
      <div className="title-row">
        <h1 ref={heading} tabIndex={-1}>
          Projects
        </h1>
        {canAddTop && (
          <Button id={NEW_PROJECT_BUTTON_ID} variant={panelEditable ? 'secondary' : 'primary'} onClick={() => startAdd(null)}>
            New project
          </Button>
        )}
      </div>

      {!hasList && projects.isError && <Alert>{messageFor(projects.error)}</Alert>}
      {!hasList && projects.isPending && <p role="status">Loading</p>}
      {actionError && <Alert>{actionError}</Alert>}
      <div role="status" aria-live="polite" className="notice">
        {notice}
      </div>
      {refreshFailed && (
        <Alert>
          <p>Couldn't refresh the list. Try again.</p>
          <Button onClick={() => void projects.refetch()}>Try again</Button>
        </Alert>
      )}

      {hasList && (
        <div className={hasPanel ? 'projects-layout has-panel' : 'projects-layout'}>
          <div className="projects-list">
            <div className="list-toolbar">
              <Field
                id="project-search"
                label="Search projects"
                type="search"
                value={filters.text}
                onChange={(e) => setFilters({ ...filters, text: e.target.value })}
              />
              <Button
                id={FILTERS_BUTTON_ID}
                aria-expanded={filtersOpen}
                aria-controls={FILTERS_PANEL_ID}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                {activeCount > 0 ? `Filters (${activeCount})` : 'Filters'}
              </Button>
            </div>
            <FiltersPanel
              open={filtersOpen}
              filters={filters}
              onChange={setFilters}
              onClear={clearFilters}
              onDone={closeFilters}
              tagsInUse={tagsInUse}
              members={members.data?.members ?? []}
              membersLoaded={members.data !== undefined}
              myId={myId ?? ''}
            />
            {!reorderable && canReorderRole && shown.length > 0 && <p className="reorder-note">Clear filters to reorder.</p>}
            {shown.length === 0 && adding === null && (
              <>
                <p>
                  {filtered && projects.items.length > 0
                    ? 'No projects match these filters.'
                    : canAddTop
                      ? 'No projects yet.'
                      : 'No projects yet. An Admin adds the first one.'}
                </p>
                {filtered && projects.items.length > 0 && <Button onClick={clearFilters}>Clear filters</Button>}
              </>
            )}
            {(shown.length > 0 || adding !== null) && (
              <ProjectTree
                roadmapId={roadmapId}
                role={role}
                myId={myId}
                items={shown}
                contextIds={view.context}
                expandAll={narrowing}
                reorderable={reorderable}
                search={search}
                byId={projects.byId}
                memberNames={memberNames}
                onChangeStatus={changeStatus}
                onOpen={openItem}
                onReorder={reorderItems}
                onArchive={archiveItem}
                onUnarchive={unarchiveItem}
                onDelete={askDelete}
                selectedId={selected?.id}
                collapsed={collapsed}
                onToggle={toggle}
                adding={adding}
                onStartAdd={startAdd}
                onAdd={async (parentId, title) => {
                  await create.mutateAsync({ parentId, title });
                  // The parent may have been collapsed while the row was open; the new item must show.
                  if (parentId) expand(parentId);
                }}
                onCancelAdd={cancelAdd}
              />
            )}
          </div>
          {selected && (
            <ProjectPanel
              key={selected.id}
              roadmapId={roadmapId}
              role={role}
              myId={me.data?.user.id}
              item={selected}
              byId={projects.byId}
              listPath={listUrl}
              onClose={closePanel}
              onReload={reloadItem}
              members={members.data?.members ?? []}
              ownChange={ownChange}
              onToggleAssignee={toggleAssignee}
              onSetPriorityLabel={changePriorityLabel}
              onDirtyChange={onDirtyChange}
            />
          )}
          {hasPanel && !selected && (
            <section className="project-panel" aria-label="Details">
              <Alert>{ROADMAP_NOT_FOUND}</Alert>
              <Link to={listUrl} className="text-link">
                Back to projects
              </Link>
            </section>
          )}
        </div>
      )}
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
}
