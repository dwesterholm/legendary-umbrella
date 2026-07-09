// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const singleMock = vi.fn();
const tickDiscoveryMock = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: singleMock,
        }),
      }),
    }),
  }),
}));

vi.mock("@/actions/tick-discovery", () => ({
  tickDiscovery: (...args: unknown[]) => tickDiscoveryMock(...args),
}));

import { DiscoveryProgress } from "@/components/discovery-progress";

describe("DiscoveryProgress", () => {
  beforeEach(() => {
    singleMock.mockReset();
    tickDiscoveryMock.mockReset();
    tickDiscoveryMock.mockResolvedValue(undefined);
  });

  it("invokes tickDiscovery(jobId) on each poll round-trip", async () => {
    singleMock.mockResolvedValue({
      data: {
        status: "processing",
        processed_count: 3,
        candidate_count: 3,
        cap_candidates: 25,
        cost_sek_total: 0.5,
        cap_reached: false,
      },
    });

    render(<DiscoveryProgress jobId="job-1" initialStatus="pending" />);

    await waitFor(() => {
      expect(tickDiscoveryMock).toHaveBeenCalledWith("job-1");
    });
  });

  it("renders the LOCKED '{n} av {total} annonser analyserade' counter while running", async () => {
    singleMock.mockResolvedValue({
      data: {
        status: "processing",
        processed_count: 12,
        candidate_count: 12,
        cap_candidates: 25,
        cost_sek_total: 0.5,
        cap_reached: false,
      },
    });

    render(<DiscoveryProgress jobId="job-1" initialStatus="pending" />);

    await waitFor(() => {
      expect(
        screen.getByText("12 av 25 annonser analyserade"),
      ).toBeInTheDocument();
    });
  });

  it("fires onComplete and stops polling when the row reaches a terminal status", async () => {
    const onComplete = vi.fn();
    singleMock.mockResolvedValue({
      data: {
        status: "done",
        processed_count: 20,
        candidate_count: 20,
        cap_candidates: 25,
        cost_sek_total: 1.2,
        cap_reached: false,
      },
    });

    render(
      <DiscoveryProgress
        jobId="job-1"
        initialStatus="processing"
        onComplete={onComplete}
      />,
    );

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith("done");
    });

    const callsAtComplete = singleMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(singleMock.mock.calls.length).toBe(callsAtComplete);
  });

  it("shows the cap-reached terracotta banner and composes with running", async () => {
    singleMock.mockResolvedValue({
      data: {
        status: "processing",
        processed_count: 25,
        candidate_count: 25,
        cap_candidates: 25,
        cost_sek_total: 2,
        cap_reached: true,
      },
    });

    render(<DiscoveryProgress jobId="job-1" initialStatus="processing" />);

    await waitFor(() => {
      expect(
        screen.getByText("Vi stannade vid 25 annonser (sökgräns)."),
      ).toBeInTheDocument();
      // Still shows the running counter alongside the cap banner.
      expect(
        screen.getByText("25 av 25 annonser analyserade"),
      ).toBeInTheDocument();
    });
  });

  it("skips an overlapping poll when tickDiscovery is still in flight (WR-03)", async () => {
    singleMock.mockResolvedValue({
      data: {
        status: "processing",
        processed_count: 3,
        candidate_count: 3,
        cap_candidates: 25,
        cost_sek_total: 0.5,
        cap_reached: false,
      },
    });

    // Make the FIRST tickDiscovery call take longer than POLL_MS (1500ms) so
    // the interval fires a second time while the first poll() is still
    // awaiting it. Without the in-flight guard, the second interval tick
    // would call tickDiscovery again (an overlapping, wasteful call); with
    // the guard it must be skipped entirely.
    let resolveFirstTick: (() => void) | undefined;
    let tickCallCount = 0;
    tickDiscoveryMock.mockImplementation(() => {
      tickCallCount += 1;
      if (tickCallCount === 1) {
        return new Promise<void>((resolve) => {
          resolveFirstTick = resolve;
        });
      }
      return Promise.resolve();
    });

    render(<DiscoveryProgress jobId="job-1" initialStatus="pending" />);

    await waitFor(() => {
      expect(tickDiscoveryMock).toHaveBeenCalledTimes(1);
    });

    // Advance real time past POLL_MS while the first tick is still pending —
    // the interval fires again, but the in-flight guard must skip it.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(tickDiscoveryMock).toHaveBeenCalledTimes(1);

    // Resolving the first call lets the guard release; the NEXT interval
    // tick is then free to call tickDiscovery again.
    resolveFirstTick?.();
    await waitFor(
      () => {
        expect(tickDiscoveryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 },
    );
  }, 10_000);

  it("shows the calm terracotta kill-switch banner + escape link on degraded", async () => {
    singleMock.mockResolvedValue({
      data: {
        status: "degraded",
        processed_count: 5,
        candidate_count: 5,
        cap_candidates: 25,
        cost_sek_total: 0.3,
        cap_reached: false,
      },
    });

    render(<DiscoveryProgress jobId="job-1" initialStatus="processing" />);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Områdessökning är tillfälligt otillgänglig. Prova att analysera en enskild annons via länk istället.",
        ),
      ).toBeInTheDocument();
    });

    const link = screen.getByRole("link", { name: /dashboard|enskild/i });
    expect(link).toHaveAttribute("href", "/dashboard");
  });
});
