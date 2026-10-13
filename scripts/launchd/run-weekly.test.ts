import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * run-weekly.sh must hand SIGTERM on to the run (WR-09): launchd signals the wrapper, not the program
 * it started. The test builds a throwaway repo layout with a fake `tsx` that closes "gracefully" on
 * SIGTERM, starts the REAL wrapper against it, sends the wrapper SIGTERM and checks the fake saw it.
 * macOS only (the wrapper uses caffeinate); no network, no real run, nothing under the real repo.
 */
const WRAPPER = join(__dirname, "run-weekly.sh");

describe.skipIf(process.platform !== "darwin")("run-weekly.sh signal forwarding", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "run-weekly-test-"));
    mkdirSync(join(root, "scripts", "launchd"), { recursive: true });
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });
    copyFileSync(WRAPPER, join(root, "scripts", "launchd", "run-weekly.sh"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fakeTsx(body: string): void {
    const file = join(root, "node_modules", ".bin", "tsx");
    writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(file, 0o755);
  }

  function runWrapper(): { child: ChildProcess; out: () => string } {
    const env = { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home") };
    const child: ChildProcess = spawn("/bin/zsh", [join(root, "scripts", "launchd", "run-weekly.sh")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout?.on("data", (d: Buffer) => (text += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (text += d.toString()));
    return { child, out: () => text };
  }

  async function until(check: () => boolean, ms = 8_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("a SIGTERM to the wrapper reaches the run, which closes gracefully; the wrapper waits and reports the run's exit code", async () => {
    const ready = join(root, "ready");
    const graceful = join(root, "graceful");
    fakeTsx(
      `trap 'sleep 0.3; echo closed > "${graceful}"; exit 143' TERM\n` + `echo up > "${ready}"\n` + `while :; do sleep 0.05; done`,
    );
    const { child, out } = runWrapper();
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    await until(() => existsSync(ready));
    child.kill("SIGTERM");
    const code = await exited;
    expect(existsSync(graceful)).toBe(true); // the run saw SIGTERM and finished its cleanup before the wrapper left
    expect(readFileSync(graceful, "utf8")).toContain("closed");
    expect(code).toBe(143);
    expect(out()).toMatch(/Slut: .*, kod 143/);
  }, 20_000);

  it("a normal run passes its exit code through and prints the closing line", async () => {
    fakeTsx("exit 4");
    const { child, out } = runWrapper();
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    expect(code).toBe(4);
    expect(out()).toMatch(/Start: /);
    expect(out()).toMatch(/Slut: .*, kod 4/);
  }, 20_000);
});
