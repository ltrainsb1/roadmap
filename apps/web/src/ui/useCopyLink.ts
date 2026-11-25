import { useState } from 'react';

/** The polite status once the link is on the clipboard. */
export const LINK_COPIED = 'Link copied.';
/** The alert when the clipboard refuses; the screen then leaves the link where it can be selected. */
export const COPY_FAILED = "Couldn't copy the link. Select it and copy it yourself.";

/** "Copy link" with its two outcomes: a polite "Link copied." or, when the clipboard refuses, a line saying what to do. */
export function useCopyLink() {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const copy = async (url: string) => {
    setResult(null);
    try {
      await navigator.clipboard.writeText(url);
      setResult('copied');
    } catch {
      setResult('failed');
    }
  };
  return { result, copy, reset: () => setResult(null) };
}
