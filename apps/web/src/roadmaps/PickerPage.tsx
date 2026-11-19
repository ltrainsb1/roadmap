import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GENERIC_ERROR } from '../api/errors.ts';
import { roleName } from '../roles.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Layout } from '../ui/Layout.tsx';
import { CreateRoadmapDialog } from './CreateRoadmapDialog.tsx';
import { useRoadmaps } from './useRoadmaps.ts';

export function PickerPage() {
  const roadmaps = useRoadmaps();
  const [creating, setCreating] = useState(false);

  return (
    <Layout width="wide" signedIn>
      <div className="title-row">
        <h1>Roadmaps</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New roadmap
        </Button>
      </div>
      {roadmaps.isError && <Alert>{GENERIC_ERROR}</Alert>}
      {roadmaps.isSuccess && roadmaps.data.length === 0 && <p>You don't have a roadmap yet.</p>}
      {roadmaps.isSuccess && roadmaps.data.length > 0 && (
        <ul className="roadmap-list" aria-label="Your roadmaps">
          {roadmaps.data.map((r) => (
            <li key={r.roadmapId}>
              <Link to={`/r/${encodeURIComponent(r.roadmapId)}/members`} className="roadmap-link">
                {r.roadmapName}
              </Link>
              <span className="badge">{roleName(r.role)}</span>
            </li>
          ))}
        </ul>
      )}
      <CreateRoadmapDialog open={creating} onClose={() => setCreating(false)} />
    </Layout>
  );
}
