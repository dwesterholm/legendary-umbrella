import { describe, it, expect, vi, beforeEach } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns", () => ({
  promises: {
    lookup: (...args: unknown[]) => lookup(...args),
  },
}));

// Imported AFTER the mock is registered.
import { isSafeExternalUrl, resolveSafeExternalUrl } from "@/lib/broker/url-guard";

beforeEach(() => {
  lookup.mockReset();
});

describe("isSafeExternalUrl", () => {
  it("resolves true for a public host (public IP)", async () => {
    lookup.mockResolvedValue({ address: "93.184.216.34", family: 4 });
    await expect(isSafeExternalUrl("https://example.com/x")).resolves.toBe(true);
  });

  it("rejects a non-http(s) protocol without ever calling dns.lookup", async () => {
    await expect(isSafeExternalUrl("ftp://x")).resolves.toBe(false);
    await expect(isSafeExternalUrl("file:///etc/passwd")).resolves.toBe(false);
    await expect(isSafeExternalUrl("gopher://x")).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects hostnames resolving to loopback, RFC1918, and link-local (incl. cloud metadata) IPv4 ranges", async () => {
    const cases = [
      "127.0.0.1", // loopback
      "10.0.0.5", // RFC1918 10/8
      "172.16.0.5", // RFC1918 172.16/12
      "192.168.1.5", // RFC1918 192.168/16
      "169.254.169.254", // link-local / cloud metadata
    ];
    for (const address of cases) {
      lookup.mockResolvedValueOnce({ address, family: 4 });
      await expect(isSafeExternalUrl("https://internal.example/")).resolves.toBe(false);
    }
  });

  it("rejects 0.0.0.0/8 (\"this network\"/unspecified) and 100.64.0.0/10 (CGNAT) IPv4 ranges (WR-01)", async () => {
    const cases = [
      "0.0.0.0", // unspecified — many systems treat as loopback-equivalent
      "0.1.2.3", // still within 0.0.0.0/8
      "100.64.0.1", // RFC 6598 CGNAT range start
      "100.100.0.1", // mid-range CGNAT
      "100.127.255.255", // CGNAT range end (100.64.0.0/10 upper bound)
    ];
    for (const address of cases) {
      lookup.mockResolvedValueOnce({ address, family: 4 });
      await expect(isSafeExternalUrl("https://internal.example/")).resolves.toBe(false);
    }
  });

  it("does not reject addresses just outside the CGNAT range (100.63.x.x, 100.128.x.x)", async () => {
    lookup.mockResolvedValueOnce({ address: "100.63.255.255", family: 4 });
    await expect(isSafeExternalUrl("https://public.example/")).resolves.toBe(true);

    lookup.mockResolvedValueOnce({ address: "100.128.0.1", family: 4 });
    await expect(isSafeExternalUrl("https://public.example/")).resolves.toBe(true);
  });

  it("rejects IPv6 loopback (::1) and link-local (fe80::) addresses", async () => {
    lookup.mockResolvedValueOnce({ address: "::1", family: 6 });
    await expect(isSafeExternalUrl("https://internal.example/")).resolves.toBe(false);

    lookup.mockResolvedValueOnce({ address: "fe80::1", family: 6 });
    await expect(isSafeExternalUrl("https://internal.example/")).resolves.toBe(false);
  });

  it("rejects IPv4-mapped IPv6, unique-local (fc00::/7), and unspecified (::) addresses (BL-1)", async () => {
    const cases = [
      "::ffff:169.254.169.254", // IPv4-mapped cloud metadata — the dangerous one
      "::ffff:10.0.0.5", // IPv4-mapped RFC1918
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:a9fe:a9fe", // IPv4-mapped cloud metadata, hex tail form
      "::169.254.169.254", // IPv4-compatible dotted form
      "fc00::1", // unique-local fc00::/8
      "fd12:3456:789a::1", // unique-local fd00::/8
      "febf::1", // upper edge of fe80::/10 link-local
      "::", // unspecified
    ];
    for (const address of cases) {
      lookup.mockResolvedValueOnce({ address, family: 6 });
      await expect(isSafeExternalUrl("https://internal.example/")).resolves.toBe(false);
    }
  });

  it("does not reject a genuinely public IPv6 address or a public IPv4-mapped address", async () => {
    lookup.mockResolvedValueOnce({ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 });
    await expect(isSafeExternalUrl("https://public.example/")).resolves.toBe(true);

    lookup.mockResolvedValueOnce({ address: "::ffff:8.8.8.8", family: 6 });
    await expect(isSafeExternalUrl("https://public.example/")).resolves.toBe(true);
  });

  it("treats a DNS resolution failure as unsafe, and a malformed URL string as unsafe", async () => {
    lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(isSafeExternalUrl("https://does-not-resolve.example/")).resolves.toBe(false);

    await expect(isSafeExternalUrl("not a url")).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalledWith("not a url");
  });
});

describe("resolveSafeExternalUrl (CR-01)", () => {
  it("returns the resolved address/family for a public host", async () => {
    lookup.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 });
    await expect(resolveSafeExternalUrl("https://example.com/x")).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });

  it("returns null for a non-http(s) protocol without ever calling dns.lookup", async () => {
    await expect(resolveSafeExternalUrl("ftp://x")).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns null when the resolved address is private/loopback/link-local", async () => {
    lookup.mockResolvedValueOnce({ address: "169.254.169.254", family: 4 });
    await expect(resolveSafeExternalUrl("https://internal.example/")).resolves.toBeNull();
  });

  it("returns null on DNS resolution failure", async () => {
    lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(
      resolveSafeExternalUrl("https://does-not-resolve.example/"),
    ).resolves.toBeNull();
  });

  it("calls dns.lookup exactly once per invocation — the single resolution the caller must pin against", async () => {
    lookup.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 });
    await resolveSafeExternalUrl("https://example.com/x");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("isSafeExternalUrl is a thin boolean wrapper over resolveSafeExternalUrl (same DNS call count)", async () => {
    lookup.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 });
    await isSafeExternalUrl("https://example.com/x");
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
