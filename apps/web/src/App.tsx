import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Fragment, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { setUnauthorizedHandler } from './api/client.ts';
import { EnrollTotpPage } from './auth/EnrollTotpPage.tsx';
import { ForgotPage } from './auth/ForgotPage.tsx';
import { InvitePage } from './auth/InvitePage.tsx';
import { LoginPage } from './auth/LoginPage.tsx';
import { MfaPage } from './auth/MfaPage.tsx';
import { RequireAuth } from './auth/RequireAuth.tsx';
import { ResetPage } from './auth/ResetPage.tsx';
import { AuditPage } from './audit/AuditPage.tsx';
import { MembersPage } from './members/MembersPage.tsx';
import { NotificationsPage } from './notifications/NotificationsPage.tsx';
import { ProjectsPage } from './projects/ProjectsPage.tsx';
import type { ProjectView } from './projects/ViewSwitcher.tsx';
import { PickerPage } from './roadmaps/PickerPage.tsx';
import { RoadmapIndex, RoadmapLayout } from './roadmaps/RoadmapLayout.tsx';
import { SecurityPage } from './settings/SecurityPage.tsx';
import { SnapshotsPage } from './snapshots/SnapshotsPage.tsx';
import { LinkProblem, SnapshotGate, ToSnapshotGate } from './viewer/SnapshotGate.tsx';
import { PrintPage } from './viewer/PrintPage.tsx';
import { SnapshotLayout } from './viewer/SnapshotLayout.tsx';

const queryClient = new QueryClient();

/** A 401 from the API sends the person to sign in and brings them back to where they were. */
function SignInRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.clear();
      void navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate, location.pathname, location.search]);
  return null;
}

/** Keyed by roadmap, so collapsed items, an open add row and the like never carry over when the roadmap is switched. */
function ProjectsRoute({ view }: { view: ProjectView }) {
  const { roadmapId } = useParams();
  return <ProjectsPage key={roadmapId} view={view} />;
}

/** Keyed by link, so a password typed or a branch collapsed for one snapshot never carries over to another. */
function PerLink({ children }: { children: ReactNode }) {
  const { linkId } = useParams();
  return <Fragment key={linkId}>{children}</Fragment>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/*
        useTransitions={false}: the project filters live in the address and drive controlled inputs (a search box,
        checkboxes), which must update in the same render as the event or typing drops keystrokes and the caret jumps.
        Cost: navigations no longer run in a React transition, so a future lazy route would show its fallback instead
        of keeping the old screen until the new one is ready.
      */}
      <BrowserRouter useTransitions={false}>
        <SignInRedirect />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/login/mfa" element={<MfaPage />} />
          <Route path="/setup/totp" element={<EnrollTotpPage />} />
          <Route path="/forgot" element={<ForgotPage />} />
          <Route path="/reset/:token" element={<ResetPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          {/*
            A snapshot's pages, for people with a link and a password and no account: outside RequireAuth, with no app
            header, and every call quiet, so nothing here ever sends anyone to sign in. Any other address under /s
            stays under /s rather than falling to the catch-all below.
          */}
          <Route
            path="/s/:linkId"
            element={
              <PerLink>
                <SnapshotGate />
              </PerLink>
            }
          />
          <Route
            path="/s/:linkId/list"
            element={
              <PerLink>
                <SnapshotLayout view="list" />
              </PerLink>
            }
          />
          <Route
            path="/s/:linkId/timeline"
            element={
              <PerLink>
                <SnapshotLayout view="timeline" />
              </PerLink>
            }
          />
          {/*
            What the PDF service prints, opened with a render token: one content call, no password page. Any other
            view under /print goes to the password page with the rest.
          */}
          <Route path="/s/:linkId/print/list" element={<PrintPage view="list" />} />
          <Route path="/s/:linkId/print/timeline" element={<PrintPage view="timeline" />} />
          <Route path="/s/:linkId/*" element={<ToSnapshotGate />} />
          <Route path="/s" element={<LinkProblem kind="not_found" />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <PickerPage />
              </RequireAuth>
            }
          />
          <Route
            path="/r/:roadmapId"
            element={
              <RequireAuth>
                <RoadmapLayout />
              </RequireAuth>
            }
          >
            <Route index element={<RoadmapIndex />} />
            <Route path="projects/:projectId?" element={<ProjectsRoute view="list" />} />
            <Route path="timeline/:projectId?" element={<ProjectsRoute view="timeline" />} />
            <Route path="board/:projectId?" element={<ProjectsRoute view="board" />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="snapshots" element={<SnapshotsPage />} />
            <Route path="audit" element={<AuditPage />} />
          </Route>
          <Route
            path="/notifications"
            element={
              <RequireAuth>
                <NotificationsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings/security"
            element={
              <RequireAuth>
                <SecurityPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
