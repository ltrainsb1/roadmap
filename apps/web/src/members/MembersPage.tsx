import { can, INVITE_ROLES, type InviteRequest, type MembersResponse } from '@roadmap/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.ts';
import { errorCode, errorMessage, messageFor } from '../api/errors.ts';
import { useMe } from '../auth/useMe.ts';
import { ROADMAPS_KEY } from '../roadmaps/useRoadmaps.ts';
import { useRoadmap } from '../roadmaps/RoadmapLayout.tsx';
import { roleName } from '../roles.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Field } from '../ui/Field.tsx';
import { formText } from '../ui/formText.ts';
import { SelectField } from '../ui/SelectField.tsx';
import { MEMBERS_KEY, useMembers } from './useMembers.ts';

type Member = MembersResponse['members'][number];
type Message = { tone: 'error' | 'success'; text: string };

export function MembersPage() {
  const { roadmapId, roadmapName, role } = useRoadmap();
  const me = useMe();
  const myId = me.data?.user.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const base = `/api/roadmaps/${encodeURIComponent(roadmapId)}`;
  const members = useMembers(roadmapId);

  const [message, setMessage] = useState<Message | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>();
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<MembersResponse['invites'][number] | null>(null);
  const [dialogError, setDialogError] = useState<string | undefined>();
  const [transferring, setTransferring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();
  const inviteForm = useRef<HTMLFormElement>(null);
  const newOwner = useRef<HTMLSelectElement>(null);
  const confirmName = useRef<HTMLInputElement>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: MEMBERS_KEY(roadmapId) });
  const fail = (err: unknown, ctx?: { email?: string }) => {
    setMessage({ tone: 'error', text: messageFor(err, ctx) });
    // A conflict or a stale list is cured by looking again.
    void refresh();
  };

  const closeDialogs = () => {
    setRemoving(null);
    setRevoking(null);
    setTransferring(false);
    setDeleting(false);
    setDialogError(undefined);
    setNameError(undefined);
  };

  const changeRole = async (member: Member, newRole: string) => {
    setMessage(null);
    try {
      await api(`${base}/members/${encodeURIComponent(member.userId)}`, { method: 'PATCH', body: { role: newRole } });
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api(`${base}/members/${encodeURIComponent(removing.userId)}`, { method: 'DELETE' });
      closeDialogs();
      await refresh();
    } catch (err) {
      setDialogError(messageFor(err));
      void refresh();
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    try {
      await api(`${base}/invites/${encodeURIComponent(revoking.id)}`, { method: 'DELETE' });
      closeDialogs();
      await refresh();
    } catch (err) {
      setDialogError(messageFor(err));
      void refresh();
    }
  };

  const invite = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const email = formText(data, 'email').trim();
    const inviteRole = formText(data, 'role') as InviteRequest['role'];
    setMessage(null);
    if (!email) return setEmailError('Enter the email address to invite.');
    setEmailError(undefined);
    try {
      await api(`${base}/invites`, { body: { email, role: inviteRole } });
      inviteForm.current?.reset();
      setMessage({ tone: 'success', text: `Invite sent to ${email}.` });
      await refresh();
    } catch (err) {
      if (errorCode(err) === 'validation') return setEmailError('Enter a valid email address.');
      fail(err, { email });
    }
  };

  const transfer = async () => {
    const userId = newOwner.current?.value;
    if (!userId) return;
    try {
      await api(`${base}/transfer`, { body: { userId } });
      closeDialogs();
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ROADMAPS_KEY })]);
    } catch (err) {
      setDialogError(messageFor(err));
      void refresh();
    }
  };

  const deleteRoadmap = async () => {
    const typed = confirmName.current?.value ?? '';
    if (typed !== roadmapName) {
      setNameError(errorMessage('confirm_mismatch'));
      confirmName.current?.focus();
      return;
    }
    try {
      await api(base, { method: 'DELETE', body: { confirmName: typed } });
      closeDialogs();
      void navigate('/');
      await queryClient.invalidateQueries({ queryKey: ROADMAPS_KEY });
    } catch (err) {
      if (errorCode(err) === 'confirm_mismatch') setNameError(messageFor(err));
      else setDialogError(messageFor(err));
    }
  };

  const canInvite = can({ role, action: 'member.invite', ctx: { newRole: 'contributor' } });
  const canTransfer = can({ role, action: 'roadmap.transfer' });
  const canDelete = can({ role, action: 'roadmap.delete' });
  const others = members.data?.members.filter((m) => m.userId !== myId) ?? [];

  return (
    <>
      <h1>Members</h1>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {members.isError && <Alert>{messageFor(members.error)}</Alert>}

      {members.isSuccess && (
        <table className="members" aria-label="Members">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.data.members.map((m) => {
              const isMe = m.userId === myId;
              const editable = !isMe && can({ role, action: 'member.changeRole', ctx: { targetRole: m.role, newRole: 'admin' } });
              const removable = !isMe && can({ role, action: 'member.remove', ctx: { targetRole: m.role } });
              return (
                <tr key={m.userId} data-testid="member-row">
                  <td data-label="Name">{m.name}</td>
                  <td data-label="Email">{m.email}</td>
                  <td data-label="Role">
                    {editable ? (
                      <select
                        aria-label={`Role for ${m.name}`}
                        value={m.role}
                        onChange={(e) => void changeRole(m, e.target.value)}
                      >
                        {INVITE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleName(r)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      roleName(m.role)
                    )}
                  </td>
                  <td className="row-actions">
                    {removable && (
                      <Button variant="danger" aria-label={`Remove ${m.name}`} onClick={() => setRemoving(m)}>
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {members.isSuccess && members.data.invites.length > 0 && (
        <section aria-labelledby="pending-heading">
          <h2 id="pending-heading">Pending invites</h2>
          <ul className="invite-list" aria-label="Pending invites">
            {members.data.invites.map((i) => (
              <li key={i.id}>
                <span>
                  {i.email}, {roleName(i.role)}
                </span>
                {can({ role, action: 'member.invite', ctx: { newRole: i.role } }) && (
                  <Button variant="danger" aria-label={`Revoke invite for ${i.email}`} onClick={() => setRevoking(i)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canInvite && (
        <section aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite someone</h2>
          <form ref={inviteForm} onSubmit={(e) => void invite(e)} noValidate>
            <Field id="invite-email" name="email" label="Email" type="email" autoComplete="off" error={emailError} />
            <SelectField id="invite-role" name="role" label="Role" defaultValue="contributor">
              <option value="contributor">{roleName('contributor')}</option>
              <option value="admin">{roleName('admin')}</option>
            </SelectField>
            <Button type="submit" variant="primary">
              Send invite
            </Button>
          </form>
        </section>
      )}

      {(canTransfer || canDelete) && (
        <section aria-labelledby="danger-heading" className="danger-zone">
          <h2 id="danger-heading">Danger zone</h2>
          <div className="danger-actions">
            {canTransfer && (
              <Button variant="danger" onClick={() => setTransferring(true)}>
                Transfer ownership
              </Button>
            )}
            {canDelete && (
              <Button variant="danger" onClick={() => setDeleting(true)}>
                Delete roadmap
              </Button>
            )}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove member"
        confirmLabel="Remove"
        error={dialogError}
        onConfirm={() => void remove()}
        onClose={closeDialogs}
      >
        <p>
          Remove {removing?.name} from {roadmapName}? They lose access right away.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke invite"
        confirmLabel="Revoke"
        error={dialogError}
        onConfirm={() => void revoke()}
        onClose={closeDialogs}
      >
        <p>Revoke the invite for {revoking?.email}? The link stops working.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={transferring}
        title="Transfer ownership"
        confirmLabel="Transfer ownership"
        informOnly={others.length === 0}
        error={dialogError}
        onConfirm={() => void transfer()}
        onClose={closeDialogs}
      >
        {others.length === 0 ? (
          <p>Invite someone first. Only a member can become the owner.</p>
        ) : (
          <>
            <p>Choose who becomes the owner. You will become an Admin.</p>
            <SelectField id="new-owner" ref={newOwner} label="New owner">
              {others.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </SelectField>
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting}
        title="Delete roadmap"
        confirmLabel="Delete roadmap"
        error={dialogError}
        onConfirm={() => void deleteRoadmap()}
        onClose={closeDialogs}
      >
        <p>Type {roadmapName} to delete it. This can't be undone.</p>
        <Field id="confirm-name" ref={confirmName} label="Roadmap name" autoComplete="off" error={nameError} />
      </ConfirmDialog>
    </>
  );
}
