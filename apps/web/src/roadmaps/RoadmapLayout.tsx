import type { Role } from '@roadmap/shared';
import { can } from '@roadmap/shared';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { GENERIC_ERROR } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Layout } from '../ui/Layout.tsx';
import { useRoadmaps } from './useRoadmaps.ts';

export interface RoadmapContext {
  roadmapId: string;
  roadmapName: string;
  role: Role;
}

/** The roadmap a screen inside `RoadmapLayout` belongs to, and the signed-in person's role in it. */
export const useRoadmap = (): RoadmapContext => useOutletContext<RoadmapContext>();

/** Header picker and nav tabs around every screen of one roadmap. Later plans add Projects and views here. */
export function RoadmapLayout() {
  const { roadmapId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const roadmaps = useRoadmaps();
  const current = roadmaps.data?.find((r) => r.roadmapId === roadmapId);

  if (roadmaps.isError) {
    return (
      <Layout width="wide" signedIn>
        <Alert>{GENERIC_ERROR}</Alert>
      </Layout>
    );
  }
  if (!roadmaps.isSuccess) {
    return (
      <Layout width="wide" signedIn>
        <p role="status">Loading</p>
      </Layout>
    );
  }
  if (!current) {
    return (
      <Layout width="wide" signedIn>
        <Alert>This roadmap doesn't exist, or you don't have access to it.</Alert>
        <Link to="/" className="text-link">
          Back to roadmaps
        </Link>
      </Layout>
    );
  }

  const base = `/r/${encodeURIComponent(roadmapId)}`;
  // Switching keeps the tab: the same section of the other roadmap.
  const section = location.pathname.slice(base.length) || '/members';
  const picker = (
    <div className="roadmap-picker">
      <label htmlFor="roadmap-picker">Roadmap</label>
      <select
        id="roadmap-picker"
        value={roadmapId}
        onChange={(e) => {
          const target = roadmaps.data.find((r) => r.roadmapId === e.target.value);
          const keep = target && section === '/audit' && !can({ role: target.role, action: 'audit.view' }) ? '/members' : section;
          void navigate(`/r/${encodeURIComponent(e.target.value)}${keep}`);
        }}
      >
        {roadmaps.data.map((r) => (
          <option key={r.roadmapId} value={r.roadmapId}>
            {r.roadmapName}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Layout width="wide" signedIn headerExtra={picker}>
      <nav aria-label="Roadmap sections" className="tabs">
        <NavLink to={`${base}/members`}>Members</NavLink>
        {can({ role: current.role, action: 'audit.view' }) && <NavLink to={`${base}/audit`}>Audit log</NavLink>}
      </nav>
      <Outlet context={{ roadmapId, roadmapName: current.roadmapName, role: current.role } satisfies RoadmapContext} />
    </Layout>
  );
}

/** `/r/:roadmapId` on its own opens the first tab. */
export function RoadmapIndex() {
  const { roadmapId = '' } = useParams();
  return <Navigate to={`/r/${encodeURIComponent(roadmapId)}/members`} replace />;
}
