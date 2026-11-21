import { activeFilterCount, can, NO_FILTERS, TIMELINE_ZOOMS, type ProjectList, type TimelineZoom } from '@roadmap/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { messageFor } from '../api/errors.ts';
import { useMe } from '../auth/useMe.ts';
import { useMembers } from '../members/useMembers.ts';
import { useRoadmap } from '../roadmaps/RoadmapLayout.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { SelectField } from '../ui/SelectField.tsx';
import { FILTERS_PANEL_ID, FiltersPanel } from './FiltersPanel.tsx';
import { filtersFromSearch, hasNarrowing, searchFor, viewOf, viewOptionsFromSearch } from './filters.ts';
import {
  actionsButtonId,
  NEW_PROJECT_BUTTON_ID,
  ProjectTree,
  useCollapsed,
  type AddTarget,
} from './ProjectTree.tsx';
import { ProjectPanel } from './ProjectPanel.tsx';
import {
  isAssigned,
  PROJECTS_KEY,
  useCreateProject,
  useProjects,
} from './useProjects.ts';
import { TimelineView } from './TimelineView.tsx';
import { todayIn } from './today.ts';
import { useItemActions } from './useItemActions.tsx';
import { viewPath, ViewSwitcher, type ProjectView } from './ViewSwitcher.tsx';

const FILTERS_BUTTON_ID = 'filters-button';
const SEARCH_ID = 'project-search';
const ZOOM_NAMES: Record<TimelineZoom, string> = { weeks: 'Weeks', months: 'Months', quarters: 'Quarters' };

/** The items of one roadmap in one view, with the search, filters, view switcher and the item panel. */
export function ProjectsPage({ view }: { view: ProjectView }) {
  const { roadmapId, role } = useRoadmap();
  const { projectId } = useParams();
  const me = useMe();
  const projects = useProjects(roadmapId);
  const members = useMembers(roadmapId);
  const create = useCreateProject(roadmapId);
  const queryClient = useQueryClient();
  const { collapsed, toggle, expand } = useCollapsed(roadmapId);
  // The filters live in the address, and nowhere else: opening an item keeps them, and a copied link shows the same list.
  const [params, setParams] = useSearchParams();
  const myId = me.data?.user.id;
  const filters = useMemo(() => filtersFromSearch(params), [params]);
  const options = useMemo(() => viewOptionsFromSearch(params), [params]);
  // Every query string is built from the filters and the view settings, so changing one keeps the others.
  const query = searchFor(filters, options).toString();
  const search = query === '' ? '' : `?${query}`;
  const navigate = useNavigate();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const basePath = viewPath(roadmapId, view);
  // Where closing the panel goes back to: the view as it was filtered.
  const viewUrl = `${basePath}${search}`;
  const hasPanel = projectId !== undefined;
  const actions = useItemActions({ roadmapId, role, myId, basePath, search, projectId, projects, members });
  const { actionError, notice, setNotice } = actions;

  const [adding, setAdding] = useState<AddTarget | null>(null);
  const narrowing = hasNarrowing(filters);
  const filtered = narrowing || filters.showArchived;
  const visible = useMemo(() => viewOf(projects.items, filters, myId), [filters, projects.items, myId]);
  const shown = visible.items;
  const tagsInUse = useMemo(() => [...new Set(projects.items.filter((i) => !i.archived).flatMap((i) => i.tags))].sort(), [projects.items]);
  const setFilters = (next: typeof filters) => setParams(searchFor(next, options), { replace: true });
  const clearFilters = () => setParams(searchFor(NO_FILTERS, options), { replace: true });
  const setZoom = (zoom: TimelineZoom) => setParams(searchFor(filters, { ...options, zoom }), { replace: true });
  // Counts presses of "Today"; the Timeline scrolls to today each time it changes.
  const [todaySignal, setTodaySignal] = useState(0);
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

  const addItem = async (parentId: string | null, title: string) => {
    const { id } = await create.mutateAsync({ parentId, title });
    // The parent may have been collapsed while the row was open; the new item must show.
    if (parentId) expand(parentId);
    if (!filtered) return;
    // The list has been refetched by now; say so when the filters hide what was just added.
    const items = queryClient.getQueryData<ProjectList>(PROJECTS_KEY(roadmapId))?.items ?? [];
    const added = items.find((i) => i.id === id);
    if (added && !viewOf(items, filters, myId).items.includes(added)) {
      setNotice(`Added ${added.title}. It doesn't match the filters, so it isn't shown.`);
    }
  };

  const clearFiltersFromNoMatch = () => {
    clearFilters();
    // The button goes with the message; the search field is where the person is likely to go next.
    document.getElementById(SEARCH_ID)?.focus();
  };

  const canAddTop = can({ role, action: 'project.create', ctx: { isAssigned: false } });
  // Adding happens on the List only, where the new item's place in the order can be seen.
  const showNewProject = canAddTop && view === 'list';
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
  const hasDates = shown.some((i) => i.startDate !== null || i.endDate !== null || i.milestones.length > 0);

  return (
    <>
      <div className="title-row">
        <h1 ref={actions.headingRef} tabIndex={-1}>
          Projects
        </h1>
        {showNewProject && (
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
                id={SEARCH_ID}
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
              <ViewSwitcher
                roadmapId={roadmapId}
                view={view}
                search={search}
                views={['list', 'timeline']}
                onNavigate={(path) => actions.unlessDirty(() => void navigate(path))}
              />
              {view === 'timeline' && (
                <>
                  <div className="toolbar-zoom">
                    <SelectField id="timeline-zoom" label="Zoom" value={options.zoom} onChange={(e) => setZoom(e.target.value as TimelineZoom)}>
                      {TIMELINE_ZOOMS.map((z) => (
                        <option key={z} value={z}>
                          {ZOOM_NAMES[z]}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  <Button onClick={() => setTodaySignal((n) => n + 1)}>Today</Button>
                </>
              )}
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
            {view === 'list' && !reorderable && canReorderRole && shown.length > 0 && <p className="reorder-note">Clear filters to reorder.</p>}
            {shown.length === 0 && (adding === null || view !== 'list') && (
              <>
                <p>
                  {filtered && projects.items.length > 0
                    ? 'No projects match these filters.'
                    : canAddTop
                      ? 'No projects yet.'
                      : 'No projects yet. An Admin adds the first one.'}
                </p>
                {filtered && projects.items.length > 0 && <Button onClick={clearFiltersFromNoMatch}>Clear filters</Button>}
              </>
            )}
            {view === 'timeline' && shown.length > 0 && (
              <>
                {!hasDates && <p>No items have dates yet. Open an item to add its dates.</p>}
                <TimelineView
                  roadmapId={roadmapId}
                  role={role}
                  myId={myId}
                  items={shown}
                  contextIds={visible.context}
                  expandAll={narrowing}
                  byId={projects.byId}
                  today={todayIn(me.data?.user.timezone ?? 'UTC')}
                  zoom={options.zoom}
                  selectedId={selected?.id}
                  collapsed={collapsed}
                  onToggle={toggle}
                  search={search}
                  actions={actions}
                  scrollToTodaySignal={todaySignal}
                />
              </>
            )}
            {view === 'list' && (shown.length > 0 || adding !== null) && (
              <ProjectTree
                roadmapId={roadmapId}
                role={role}
                myId={myId}
                items={shown}
                contextIds={visible.context}
                expandAll={narrowing}
                reorderable={reorderable}
                search={search}
                byId={projects.byId}
                memberNames={memberNames}
                onChangeStatus={actions.changeStatus}
                onOpen={actions.openItem}
                onReorder={actions.reorderItems}
                onArchive={actions.archiveItem}
                onUnarchive={actions.unarchiveItem}
                onDelete={actions.askDelete}
                selectedId={selected?.id}
                collapsed={collapsed}
                onToggle={toggle}
                adding={adding}
                onStartAdd={startAdd}
                onAdd={addItem}
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
              listPath={viewUrl}
              onClose={actions.closePanel}
              onReload={actions.reloadItem}
              members={members.data?.members ?? []}
              ownChange={actions.ownChange}
              onToggleAssignee={actions.toggleAssignee}
              onSetPriorityLabel={actions.changePriorityLabel}
              onDirtyChange={actions.onDirtyChange}
            />
          )}
          {hasPanel && !selected && (
            <section className="project-panel" aria-label="Details">
              <Alert>This item no longer exists, or you don't have access to it.</Alert>
              <Link to={viewUrl} className="text-link">
                Back to projects
              </Link>
            </section>
          )}
        </div>
      )}
      {actions.dialogs}
    </>
  );
}
