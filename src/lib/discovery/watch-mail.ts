/**
 * watch-mail.ts - sends the weekly mail through SMTP (Phase 14.2, WATCH-05, D-15, R-02).
 *
 * SECRET POSTURE (T-14.2-11): the SMTP URL carries a password and the recipient is a private
 * address. Both come from the environment only (`WATCH_SMTP_URL`, `WATCH_EMAIL_TO`, optionally
 * `WATCH_EMAIL_FROM`, which defaults to the recipient). Neither value is ever returned, logged or
 * written anywhere: callers learn only "sent" (with a count), "no-env" (with the NAMES of the missing
 * variables) or "failed" (with an error code such as "EAUTH" or "ECONNECTION", never the message
 * text, because an SMTP error message can repeat the host or the user name).
 *
 * LOADING: nodemailer is pinned exactly (package.json) and loaded by dynamic `import()` inside
 * {@link sendWatchMail}, here and nowhere else. A `--replay` run that never sends therefore never
 * loads it, and a missing package cannot break the dependency-free parts of the script.
 *
 * No network access happens unless both variables are set and a transport is created.
 */

/** The environment variable names (the names are public, the values never are). */
export const WATCH_MAIL_ENV = { url: "WATCH_SMTP_URL", to: "WATCH_EMAIL_TO", from: "WATCH_EMAIL_FROM" } as const;

export interface WatchMailMessage {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export type WatchMailResult =
  /** The server accepted the message; `accepted` is how many recipients it took (not who). */
  | { status: "sent"; accepted: number }
  /** A variable is missing; `missing` holds variable NAMES only. Nothing was loaded or sent. */
  | { status: "no-env"; missing: string[] }
  /** The send failed; `code` is an error code only. */
  | { status: "failed"; code: string };

/** The part of a nodemailer transport this module uses. */
export interface MailTransport {
  sendMail(options: { from: string; to: string; subject: string; text: string; html: string }): Promise<{
    accepted?: ReadonlyArray<unknown>;
    rejected?: ReadonlyArray<unknown>;
  }>;
}

/** Creates a transport from the SMTP URL. The default loads nodemailer by dynamic import. */
export type LoadTransport = (smtpUrl: string) => Promise<MailTransport>;

const defaultLoadTransport: LoadTransport = async (smtpUrl) => {
  const mod = await import("nodemailer");
  // nodemailer is CommonJS: depending on the loader, createTransport is a named export or on `default`.
  const create = mod.createTransport ?? mod.default?.createTransport;
  return create(smtpUrl) as MailTransport;
};

/** An error code and nothing else: `error.code`, else a numeric `responseCode`, else "UNKNOWN". */
function errorCodeOf(error: unknown): string {
  const e = error as { code?: unknown; responseCode?: unknown } | null;
  if (typeof e?.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(e.code)) return e.code;
  if (typeof e?.responseCode === "number") return String(e.responseCode);
  return "UNKNOWN";
}

/**
 * Sends one mail. Without both `WATCH_SMTP_URL` and `WATCH_EMAIL_TO` it returns "no-env" without
 * loading nodemailer. Never throws: every failure becomes `{ status: "failed", code }`.
 */
export async function sendWatchMail(
  message: WatchMailMessage,
  opts: { env?: Readonly<Record<string, string | undefined>>; loadTransport?: LoadTransport } = {},
): Promise<WatchMailResult> {
  const env = opts.env ?? process.env;
  const url = env[WATCH_MAIL_ENV.url];
  const to = env[WATCH_MAIL_ENV.to];
  const missing: string[] = [];
  if (!url) missing.push(WATCH_MAIL_ENV.url);
  if (!to) missing.push(WATCH_MAIL_ENV.to);
  if (missing.length > 0 || !url || !to) return { status: "no-env", missing };

  const from = env[WATCH_MAIL_ENV.from] || to;
  try {
    const transport = await (opts.loadTransport ?? defaultLoadTransport)(url);
    const info = await transport.sendMail({ from, to, subject: message.subject, text: message.text, html: message.html });
    if (Array.isArray(info?.accepted) && info.accepted.length === 0) return { status: "failed", code: "NOT_ACCEPTED" };
    return { status: "sent", accepted: Array.isArray(info?.accepted) ? info.accepted.length : 0 };
  } catch (error) {
    return { status: "failed", code: errorCodeOf(error) };
  }
}
