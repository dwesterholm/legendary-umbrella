import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";

/**
 * fetch-broker-page.dns-pinning.test.ts — CR-01 end-to-end regression test.
 *
 * Unlike parse-broker-page.test.ts's mocked-fetch unit tests (which assert a
 * dispatcher OBJECT is passed to fetch), this test exercises the REAL
 * `fetchBrokerListingPage` + real `fetch`/undici `Agent` pinning mechanism
 * against a real local HTTP server, with only `resolveSafeExternalUrl`
 * mocked (standing in for "the guard already validated this address").
 *
 * The hostname used, `dns-rebinding-test.invalid`, deliberately does NOT
 * resolve via real DNS (`.invalid` is reserved by RFC 2606 to never
 * resolve). If the pre-CR-01 vulnerable code path were still active —
 * calling plain `fetch(url)` and letting undici perform its own,
 * independent DNS resolution — the request would fail with an ENOTFOUND-
 * class error, since the hostname has no real DNS record. The fix pins the
 * connection to the resolved address returned by the guard via a custom
 * `Agent.connect.lookup` override, so the request succeeds by connecting
 * directly to that address regardless of the hostname's real resolvability.
 */

const resolveSafeExternalUrl = vi.fn();
vi.mock("@/lib/broker/url-guard", () => ({
  resolveSafeExternalUrl: (...args: unknown[]) => resolveSafeExternalUrl(...args),
}));

// Imported AFTER the mock is registered — exercises the REAL undici Agent
// pinning logic in fetch-broker-page.ts; only the guard's address
// resolution is faked.
const { fetchBrokerListingPage } = await import("@/lib/broker/fetch-broker-page");

let server: Server | undefined;

afterEach(async () => {
  resolveSafeExternalUrl.mockReset();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("fetchBrokerListingPage — DNS-rebinding TOCTOU regression (CR-01)", () => {
  it("connects to the guard-validated address via a pinned dispatcher, even though the URL's hostname has no real DNS record", async () => {
    let requestCount = 0;
    let receivedHostHeader: string | undefined;
    server = createServer((req, res) => {
      requestCount += 1;
      receivedHostHeader = req.headers.host;
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><body><p class="description">Real server response</p></body></html>');
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected server to bind to a network address");
    }
    const port = address.port;

    // The guard "already validated" this hostname resolves to the local
    // server's real address — this is the ONE resolution the fetch must be
    // pinned to.
    resolveSafeExternalUrl.mockResolvedValue({ address: "127.0.0.1", family: 4 });

    // This hostname is RFC 2606 reserved and guaranteed to never resolve via
    // real DNS. A non-pinned fetch would fail here; a pinned fetch succeeds
    // because it never asks real DNS about this hostname at all.
    const url = `http://dns-rebinding-test.invalid:${port}/listing`;
    const result = await fetchBrokerListingPage(url);

    expect(result).not.toBeNull();
    expect(result?.description).toBe("Real server response");
    expect(requestCount).toBe(1);
    // The original hostname is still sent as the Host header (SNI-equivalent
    // for plain HTTP) — only the connect-time address resolution is pinned,
    // so the request still targets the correct virtual host on the server.
    expect(receivedHostHeader).toContain("dns-rebinding-test.invalid");
  });
});
