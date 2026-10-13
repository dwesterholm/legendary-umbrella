/**
 * Minimal ambient declaration for nodemailer (Phase 14.2, R-02): the pinned release ships no types and
 * no extra types package is added. It declares only what `src/lib/discovery/watch-mail.ts` uses:
 * `createTransport(url)` and `sendMail({ from, to, subject, text, html })`.
 */
declare module "nodemailer" {
  export interface SendMailOptions {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }

  export interface SentMessageInfo {
    messageId?: string;
    accepted?: ReadonlyArray<string | { address: string }>;
    rejected?: ReadonlyArray<string | { address: string }>;
  }

  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>;
  }

  export function createTransport(url: string): Transporter;

  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
