import type { IdResponse } from '@roadmap/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.ts';
import { messageFor } from '../api/errors.ts';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Field } from '../ui/Field.tsx';
import { ROADMAPS_KEY } from './useRoadmaps.ts';

export function CreateRoadmapDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nameInput = useRef<HTMLInputElement>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();

  const close = () => {
    setFieldError(undefined);
    setFormError(undefined);
    onClose();
  };

  const create = async () => {
    const name = nameInput.current?.value.trim() ?? '';
    if (!name) {
      setFieldError('Enter a name for the roadmap.');
      nameInput.current?.focus();
      return;
    }
    try {
      const { id } = await api<IdResponse>('/api/roadmaps', { body: { name } });
      await queryClient.invalidateQueries({ queryKey: ROADMAPS_KEY });
      close();
      void navigate(`/r/${encodeURIComponent(id)}/members`);
    } catch (err) {
      setFormError(messageFor(err));
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title="New roadmap"
      confirmLabel="Create roadmap"
      danger={false}
      error={formError}
      onConfirm={() => void create()}
      onClose={close}
    >
      <Field id="roadmap-name" ref={nameInput} name="name" label="Name" maxLength={120} autoComplete="off" error={fieldError} />
    </ConfirmDialog>
  );
}
