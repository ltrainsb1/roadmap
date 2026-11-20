import { useState, type FormEvent } from 'react';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';

export function downloadCodes(codes: string[]): void {
  const url = URL.createObjectURL(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'roadmap-recovery-codes.txt';
  a.click();
  URL.revokeObjectURL(url);
}

interface RecoveryCodesProps {
  codes: string[];
  /** Label of the button that finishes the step. */
  submitLabel: string;
  /** Called once the person has ticked the box and pressed the button. */
  onDone: () => void | Promise<void>;
}

/** The recovery codes, shown once: explanation, the codes, a download button and the "I saved these codes" step. */
export function RecoveryCodes({ codes, submitLabel, onDone }: RecoveryCodesProps) {
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!new FormData(e.currentTarget).get('saved')) {
      return setError('Tick the box to confirm you saved your codes.');
    }
    await onDone();
  };

  return (
    <>
      <p>Each code works once. You need one if you lose your phone.</p>
      {error && <Alert>{error}</Alert>}
      <ul className="codes" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button className="btn-block" onClick={() => downloadCodes(codes)}>
        Download codes
      </Button>
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="check">
          <input id="saved" name="saved" type="checkbox" />
          <label htmlFor="saved">I saved these codes</label>
        </div>
        <Button type="submit" variant="primary" className="btn-block">
          {submitLabel}
        </Button>
      </form>
    </>
  );
}
