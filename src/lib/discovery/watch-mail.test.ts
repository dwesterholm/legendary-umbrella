import { afterEach, describe, expect, it, vi } from "vitest";
import { WATCH_MAIL_ENV, WATCH_MARK_SEEN_WITHOUT_SMTP, decideAfterSend, sendWatchMail, type LoadTransport, type MailTransport, type WatchMailResult } from "./watch-mail";

const FAKE_URL = "smtp://mailuser:S3cretPassw0rd!@smtp.example.test:587";
const FAKE_TO = "private.person@example.test";
const MESSAGE = { subject: "Bostadsbevakning 2026-10-20: 1 nya, 0 prisändrade", text: "text body", html: "<p>html body</p>" };
const ENV = { WATCH_SMTP_URL: FAKE_URL, WATCH_EMAIL_TO: FAKE_TO };

function fakeTransport(result: Awaited<ReturnType<MailTransport["sendMail"]>> | Error) {
  const calls: Parameters<MailTransport["sendMail"]>[0][] = [];
  const urls: string[] = [];
  const load: LoadTransport = async (url) => {
    urls.push(url);
    return {
      sendMail: async (options) => {
        calls.push(options);
        if (result instanceof Error) throw result;
        return result;
      },
    };
  };
  return { load, calls, urls };
}

afterEach(() => vi.restoreAllMocks());

describe("WATCH_MAIL_ENV", () => {
  it("names the three variables", () => {
    expect(WATCH_MAIL_ENV).toEqual({ url: "WATCH_SMTP_URL", to: "WATCH_EMAIL_TO", from: "WATCH_EMAIL_FROM" });
  });
});

describe("sendWatchMail", () => {
  it("sends subject, text and html to the recipient, from the recipient by default", async () => {
    const t = fakeTransport({ accepted: [FAKE_TO] });
    const r = await sendWatchMail(MESSAGE, { env: ENV, loadTransport: t.load });
    expect(r).toEqual({ status: "sent", accepted: 1 });
    expect(t.urls).toEqual([FAKE_URL]);
    expect(t.calls).toEqual([{ from: FAKE_TO, to: FAKE_TO, ...MESSAGE }]);
  });

  it("uses WATCH_EMAIL_FROM when set", async () => {
    const t = fakeTransport({ accepted: [FAKE_TO] });
    await sendWatchMail(MESSAGE, { env: { ...ENV, WATCH_EMAIL_FROM: "bevakning@example.test" }, loadTransport: t.load });
    expect(t.calls[0].from).toBe("bevakning@example.test");
  });

  it("no env: no-env with the variable names, and nothing is loaded", async () => {
    const load = vi.fn<LoadTransport>();
    expect(await sendWatchMail(MESSAGE, { env: {}, loadTransport: load })).toEqual({
      status: "no-env",
      missing: ["WATCH_SMTP_URL", "WATCH_EMAIL_TO"],
    });
    expect(await sendWatchMail(MESSAGE, { env: { WATCH_SMTP_URL: FAKE_URL }, loadTransport: load })).toEqual({
      status: "no-env",
      missing: ["WATCH_EMAIL_TO"],
    });
    expect(await sendWatchMail(MESSAGE, { env: { WATCH_SMTP_URL: "", WATCH_EMAIL_TO: FAKE_TO }, loadTransport: load })).toEqual({
      status: "no-env",
      missing: ["WATCH_SMTP_URL"],
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("a failed send returns the error code only", async () => {
    const error = Object.assign(new Error(`Invalid login for ${FAKE_TO} at smtp.example.test`), { code: "EAUTH" });
    const t = fakeTransport(error);
    const r = await sendWatchMail(MESSAGE, { env: ENV, loadTransport: t.load });
    expect(r).toEqual({ status: "failed", code: "EAUTH" });
  });

  it("falls back to the numeric responseCode, then to UNKNOWN", async () => {
    const t1 = fakeTransport(Object.assign(new Error("x"), { responseCode: 550 }));
    expect(await sendWatchMail(MESSAGE, { env: ENV, loadTransport: t1.load })).toEqual({ status: "failed", code: "550" });
    const t2 = fakeTransport(new Error("something with a secret"));
    expect(await sendWatchMail(MESSAGE, { env: ENV, loadTransport: t2.load })).toEqual({ status: "failed", code: "UNKNOWN" });
  });

  it("a code that looks like free text is not passed on", async () => {
    const t = fakeTransport(Object.assign(new Error("x"), { code: `bad ${FAKE_TO}` }));
    expect(await sendWatchMail(MESSAGE, { env: ENV, loadTransport: t.load })).toEqual({ status: "failed", code: "UNKNOWN" });
  });

  it("a transport that cannot be created is a failure, not a throw", async () => {
    const load: LoadTransport = async () => {
      throw Object.assign(new Error(`bad url ${FAKE_URL}`), { code: "MODULE_NOT_FOUND" });
    };
    expect(await sendWatchMail(MESSAGE, { env: ENV, loadTransport: load })).toEqual({ status: "failed", code: "MODULE_NOT_FOUND" });
  });

  it("a server that accepts nobody is a failure", async () => {
    const t = fakeTransport({ accepted: [], rejected: [FAKE_TO] });
    expect(await sendWatchMail(MESSAGE, { env: ENV, loadTransport: t.load })).toEqual({ status: "failed", code: "NOT_ACCEPTED" });
  });
});

describe("secrets", () => {
  it("never prints the SMTP URL, the password or the recipient (success, failure, no-env)", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");

    const results = [
      await sendWatchMail(MESSAGE, { env: ENV, loadTransport: fakeTransport({ accepted: [FAKE_TO] }).load }),
      await sendWatchMail(MESSAGE, {
        env: ENV,
        loadTransport: fakeTransport(Object.assign(new Error(`login failed for ${FAKE_TO} on ${FAKE_URL}`), { code: "EAUTH" })).load,
      }),
      await sendWatchMail(MESSAGE, { env: { WATCH_EMAIL_TO: FAKE_TO }, loadTransport: vi.fn() }),
    ];

    const everything = [
      JSON.stringify(results),
      ...spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))),
      ...[stdout, stderr].flatMap((s) => s.mock.calls.map((c) => String(c[0]))),
    ].join("\n");
    for (const secret of [FAKE_URL, "S3cretPassw0rd", "mailuser", FAKE_TO, "private.person", "smtp.example.test"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("the real nodemailer is loaded by dynamic import and a refused connection comes back as a code only", async () => {
    // 127.0.0.1:1 refuses at once: no network leaves this machine.
    const url = "smtp://mailuser:S3cretPassw0rd!@127.0.0.1:1";
    const r = await sendWatchMail(MESSAGE, { env: { WATCH_SMTP_URL: url, WATCH_EMAIL_TO: FAKE_TO } });
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).not.toContain("S3cretPassw0rd");
    expect(JSON.stringify(r)).not.toContain(FAKE_TO);
    expect((r as { code: string }).code).toMatch(/^[A-Za-z0-9_.-]+$/);
  }, 20_000);
});

describe("decideAfterSend (WR-03)", () => {
  const ctx = { nNew: 3, nChanged: 1, htmlPath: ".planning/calibration/data/weekly-2026-10-19.html" };

  it("a delivered mail marks the flats as seen and exits 0", () => {
    const d = decideAfterSend({ status: "sent", accepted: 1 }, { ...ctx, env: {} });
    expect(d).toMatchObject({ saveMemory: true, exitCode: 0 });
    expect(d.log.text).toContain("3 nya, 1 prisändrade");
  });

  it("missing SMTP variables leave the memory untouched and exit 4, naming the variables and the file", () => {
    const d = decideAfterSend({ status: "no-env", missing: ["WATCH_SMTP_URL"] }, { ...ctx, env: {} });
    expect(d).toMatchObject({ saveMemory: false, exitCode: 4 });
    expect(d.log.level).toBe("error");
    expect(d.log.text).toContain("WATCH_SMTP_URL saknas");
    expect(d.log.text).toContain("weekly-2026-10-19.html");
  });

  it("WATCH_MARK_SEEN_WITHOUT_SMTP=1 is the opt-in to mark them seen without a mail; any other value is not", () => {
    const missing: WatchMailResult = { status: "no-env", missing: ["WATCH_EMAIL_TO"] };
    expect(decideAfterSend(missing, { ...ctx, env: { [WATCH_MARK_SEEN_WITHOUT_SMTP]: "1" } })).toMatchObject({ saveMemory: true, exitCode: 0 });
    for (const v of ["0", "true", "", undefined]) {
      expect(decideAfterSend(missing, { ...ctx, env: { [WATCH_MARK_SEEN_WITHOUT_SMTP]: v } })).toMatchObject({ saveMemory: false, exitCode: 4 });
    }
  });

  it("a failed send keeps the memory, exits 4 and shows the error code only; the opt-in does not apply to it", () => {
    const d = decideAfterSend({ status: "failed", code: "EAUTH" }, { ...ctx, env: { [WATCH_MARK_SEEN_WITHOUT_SMTP]: "1" } });
    expect(d).toMatchObject({ saveMemory: false, exitCode: 4 });
    expect(d.log.text).toContain("EAUTH");
  });
});
