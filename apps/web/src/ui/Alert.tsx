import type { ReactNode, Ref } from 'react';

interface AlertProps {
  children: ReactNode;
  /** `error` and `info` interrupt a screen reader (role alert); `success` waits its turn (role status). */
  tone?: 'error' | 'success' | 'info';
  ref?: Ref<HTMLDivElement>;
}

export function Alert({ children, tone = 'error', ref }: AlertProps) {
  return (
    <div ref={ref} role={tone === 'success' ? 'status' : 'alert'} tabIndex={-1} className={`alert alert-${tone}`}>
      {children}
    </div>
  );
}
