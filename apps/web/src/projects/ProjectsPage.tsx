import { can } from '@roadmap/shared';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { messageFor } from '../api/errors.ts';
import { useMe } from '../auth/useMe.ts';
import { useMembers } from '../members/useMembers.ts';
import { useRoadmap } from '../roadmaps/RoadmapLayout.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import {
  actionsButtonId,
  NEW_PROJECT_BUTTON_ID,
  ProjectTree,
  useCollapsed,
  type AddTarget,
} from './ProjectTree.tsx';
import { useCreateProject, useProjects } from './useProjects.ts';

export function ProjectsPage() {
  const { roadmapId, role } = useRoadmap();
  const { projectId } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const projects = useProjects(roadmapId);
  const members = useMembers(roadmapId);
  const create = useCreateProject(roadmapId);
  const { collapsed, toggle, expand } = useCollapsed(roadmapId);
  const [adding, setAdding] = useState<AddTarget | null>(null);

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

  const canAddTop = can({ role, action: 'project.create', ctx: { isAssigned: false } });
  // The list shows whenever its data is there: a failed refresh must not unmount the rows, an open add row or focus.
  // The members only name the assignees, so a slow or failed members list leaves the names out and nothing more.
  const hasList = projects.data !== undefined;
  const refreshFailed = hasList && projects.isRefetchError;

  return (
    <>
      <div className="title-row">
        <h1>Projects</h1>
        {canAddTop && (
          <Button id={NEW_PROJECT_BUTTON_ID} variant="primary" onClick={() => startAdd(null)}>
            New project
          </Button>
        )}
      </div>

      {!hasList && projects.isError && <Alert>{messageFor(projects.error)}</Alert>}
      {!hasList && projects.isPending && <p role="status">Loading</p>}
      {refreshFailed && (
        <Alert>
          <p>Couldn't refresh the list. Try again.</p>
          <Button onClick={() => void projects.refetch()}>Try again</Button>
        </Alert>
      )}

      {hasList && (
        <div className={selected ? 'projects-layout has-panel' : 'projects-layout'}>
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
            <aside className="project-panel" aria-label="Details">
              <h2>{selected.title}</h2>
              <Button onClick={() => void navigate(`/r/${encodeURIComponent(roadmapId)}/projects`)}>Close</Button>
            </aside>
          )}
        </div>
      )}
    </>
  );
}
