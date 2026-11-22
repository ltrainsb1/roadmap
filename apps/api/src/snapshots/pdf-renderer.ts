import type { Config } from '../config.ts';

/** Prints a snapshot's print page (`/s/{linkId}/print/{view}`), opened with a render token, as a PDF. */
export interface PdfRenderer {
  render(input: { path: string; token: string }): Promise<Buffer>;
}

/** The PDF service is already making as many PDFs as it can: try again later. */
export class PdfBusyError extends Error {
  constructor(message = 'pdf_busy', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfBusyError';
  }
}

/** No PDF: the service refused the page, timed out, failed, could not be reached, or sent something else. */
export class PdfFailedError extends Error {
  constructor(message = 'pdf_failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfFailedError';
  }
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/** True when the bytes start like a PDF file. */
export const looksLikePdf = (bytes: Buffer): boolean =>
  bytes.length >= PDF_MAGIC.length && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);

/** Production: the PDF service on the Compose network. 503 is busy; anything but a 200 PDF is a failure. */
export class HttpPdfRenderer implements PdfRenderer {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  constructor(opts: { url: string; timeoutMs: number; fetch?: typeof fetch }) {
    this.#endpoint = `${opts.url.replace(/\/+$/, '')}/render`;
    this.#timeoutMs = opts.timeoutMs;
    this.#fetch = opts.fetch ?? fetch;
  }

  async render(input: { path: string; token: string }): Promise<Buffer> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      const res = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: input.path, token: input.token }),
        signal: controller.signal,
      });
      if (res.status === 503) {
        await res.body?.cancel();
        throw new PdfBusyError();
      }
      const type = res.headers.get('content-type') ?? '';
      if (res.status !== 200 || !type.startsWith('application/pdf')) {
        await res.body?.cancel();
        throw new PdfFailedError(`pdf_status_${res.status}`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!looksLikePdf(bytes)) throw new PdfFailedError('pdf_not_a_pdf');
      return bytes;
    } catch (err) {
      if (err instanceof PdfBusyError || err instanceof PdfFailedError) throw err;
      throw new PdfFailedError(timedOut ? 'pdf_timeout' : 'pdf_unreachable', { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A one-page PDF with an empty A4 landscape page, its cross-reference offsets computed so readers accept it. */
function smallPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Local, test and E2E runs: records what it was asked to print and returns a small, valid PDF. */
export class FakePdfRenderer implements PdfRenderer {
  readonly calls: Array<{ path: string; token: string }> = [];
  render(input: { path: string; token: string }): Promise<Buffer> {
    this.calls.push({ path: input.path, token: input.token });
    return Promise.resolve(smallPdf());
  }
}

export function createPdfRenderer(config: Pick<Config, 'pdf' | 'pdfUrl' | 'pdfTimeoutMs'>): PdfRenderer {
  switch (config.pdf) {
    case 'fake':
      return new FakePdfRenderer();
    case 'service':
      if (!config.pdfUrl) throw new Error('PDF=service needs PDF_URL');
      return new HttpPdfRenderer({ url: config.pdfUrl, timeoutMs: config.pdfTimeoutMs });
  }
}
