import { can, type Project, type ProjectList, type ProjectStatus } from '@roadmap/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorCode, messageFor } from '../api/errors.ts';
import { useMe } from '../auth/useMe.ts';
import { useMembers } from '../members/useMembers.ts';
import { ROADMAP_NOT_FOUND, useRoadmap } from '../roadmaps/RoadmapLayout.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import {
  actionsButtonId,
  NEW_PROJECT_BUTTON_ID,
  ProjectTree,
  titleLinkId,
  useCollapsed,
  type AddTarget,
} from './ProjectTree.tsx';
import { ProjectPanel } from './ProjectPanel.tsx';
import { isAssigned, PROJECTS_KEY, useCreateProject, useProjects, useUpdateProject } from './useProjects.ts';

export function ProjectsPage() {
  const { roadmapId, role } = useRoadmap();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const projects = useProjects(roadmapId);
  const members = useMembers(roadmapId);
  const create = useCreateProject(roadmapId);
  const update = useUpdateProject(roadmapId);
  const queryClient = useQueryClient();
  const { collapsed, toggle, expand } = useCollapsed(roadmapId);
  const [adding, setAdding] = useState<AddTarget | null>(null);
  const [statusError, setStatusError] = useState<string | undefined>();
  // The latest save from a row's status pill, which the open panel adopts so its own Save does not conflict with it.
  const [ownStatusChange, setOwnStatusChange] = useState<{ id: string; version: number; status: ProjectStatus; n: number }>();
  // Whether the open panel has unsaved edits, and what to do once the person agrees to discard them.
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => void (dirty.current = value), []);
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  // Status changes run one after another, each starting from the newest saved version of its item.
  const statusQueue = useRef<Promise<void>>(Promise.resolve());
  const heading = useRef<HTMLHeadingElement>(null);
  // Set when the panel is closed on purpose: once the list is back in view, focus returns to that item's title.
  const returnFocusTo = useRef<string | null>(null);

  const shown = useMemo(() => projects.items.filter((i) => !i.archived), [projects.items]);
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
  const hasPanel = projectId !== undefined;

  /** Runs `action` now, or after the person agrees to discard unsaved edits in the panel. */
  const unlessDirty = (action: () => void) => {
    if (dirty.current) setPendingDiscard(() => action);
    else action();
  };
  const closePanel = () =>
    unlessDirty(() => {
      returnFocusTo.current = projectId ?? null;
      void navigate(listPath);
    });
  const openItem = (itemId: string) => {
    if (itemId === projectId) return;
    unlessDirty(() => void navigate(`${listPath}/${encodeURIComponent(itemId)}`));
  };
  useEffect(() => {
    if (hasPanel || returnFocusTo.current === null) return;
    // The row's title if it is still in the list, otherwise the page heading.
    (document.getElementById(titleLinkId(returnFocusTo.current)) ?? heading.current)?.focus();
    returnFocusTo.current = null;
  }, [hasPanel]);

  const changeStatus = (item: Project, status: ProjectStatus) => {
    statusQueue.current = statusQueue.current.then(async () => {
      const list = queryClient.getQueryData<ProjectList>(PROJECTS_KEY(roadmapId));
      const current = list?.items.find((i) => i.id === item.id) ?? item;
      if (status === current.status) return;
      try {
        const saved = await update.mutateAsync({ projectId: item.id, body: { version: current.version, status } });
        setStatusError(undefined);
        setOwnStatusChange((last) => ({ id: saved.id, version: saved.version, status: saved.status, n: (last?.n ?? 0) + 1 }));
      } catch (err) {
        setStatusError(messageFor(err));
        // Someone else changed it first: the list shows what they saved.
        if (errorCode(err) === 'conflict') await projects.refetch();
      }
    });
  };

  const reloadItem = async (): Promise<Project | undefined> => {
    const fresh = await projects.refetch({ throwOnError: true });
    return fresh.data?.items.find((i) => i.id === projectId);
  };

  const canAddTop = can({ role, action: 'project.create', ctx: { isAssigned: false } });
  // The list shows whenever its data is there: a failed refresh must not unmount the rows, an open add row or focus.
  // The members only name the assignees, so a slow or failed members list leaves the names out and nothing more.
  const hasList = projects.data !== undefined;
  // Save is the primary button while an editable panel is open; otherwise "New project" is.
  const panelEditable =
    selected !== undefined && can({ role, action: 'project.edit', ctx: { isAssigned: isAssigned(selected, me.data?.user.id, projects.byId) } });
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
      {statusError && <Alert>{statusError}</Alert>}
      {refreshFailed && (
        <Alert>
          <p>Couldn't refresh the list. Try again.</p>
          <Button onClick={() => void projects.refetch()}>Try again</Button>
        </Alert>
      )}

      {hasList && (
        <div className={hasPanel ? 'projects-layout has-panel' : 'projects-layout'}>
          <div className="projects-list">
            {shown.length === 0 && adding === null && (
              <p>{canAddTop ? 'No projects yet.' : 'No projects yet. An Admin adds the first one.'}</p>
            )}
            {(shown.length > 0 || adding !== null) && (
              <ProjectTree
                roadmapId={roadmapId}
                role={role}
                myId={me.data?.user.id}
                items={shown}
                byId={projects.byId}
                memberNames={memberNames}
                onChangeStatus={changeStatus}
                onOpen={openItem}
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
              listPath={listPath}
              onClose={closePanel}
              onReload={reloadItem}
              ownStatusChange={ownStatusChange}
              onDirtyChange={onDirtyChange}
            />
          )}
          {hasPanel && !selected && (
            <section className="project-panel" aria-label="Details">
              <Alert>{ROADMAP_NOT_FOUND}</Alert>
              <Link to={listPath} className="text-link">
                Back to projects
              </Link>
            </section>
          )}
        </div>
      )}
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
