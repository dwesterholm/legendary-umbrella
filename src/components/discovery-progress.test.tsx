// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

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

import {
  DiscoveryProgress,
  STATUS_LABELS,
  KNOWN_STATUSES,
  POLL_MS,
  SOFT_THRESHOLD_MS,
  ABSOLUTE_CEILING_MS,
} from "@/components/discovery-progress";

describe("DiscoveryProgress — STATUS_LABELS exhaustiveness (D-06, D-07)", () => {
  beforeEach(() => {
    singleMock.mockReset();
    tickDiscoveryMock.mockReset();
    tickDiscoveryMock.mockResolvedValue(undefined);
  });

  it("has a non-empty Swedish label for every known job status", () => {
    for (const knownStatus of KNOWN_STATUSES) {
      expect(typeof STATUS_LABELS[knownStatus]).toBe("string");
      expect(STATUS_LABELS[knownStatus].length).toBeGreaterThan(0);
    }
  });

  it("covers exactly the 6 known statuses", () => {
    expect(KNOWN_STATUSES).toEqual([
      "pending",
      "processing",
      "vision_processing",
      "done",
      "failed",
      "degraded",
    ]);
  });

  it("renders 'Analyserar bilder' for a vision_processing row (D-06)", async () => {
    singleMock.mockResolvedValue({
      data: {
        status: "vision_processing",
        processed_count: 20,
        candidate_count: 20,
        cap_candidates: 25,
        cost_sek_total: 1.5,
        cap_reached: false,
      },
    });

    render(
      <DiscoveryProgress jobId="job-1" initialStatus="vision_processing" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Analyserar bilder")).toBeInTheDocument();
    });
  });
});

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

describe("DiscoveryProgress — two-tier poll timeout (D-04, D-05)", () => {
  beforeEach(() => {
    singleMock.mockReset();
    tickDiscoveryMock.mockReset();
    tickDiscoveryMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the calm soft-notice at SOFT_THRESHOLD_MS, does NOT call onComplete, and keeps polling (D-04)", async () => {
    const onComplete = vi.fn();
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

    render(
      <DiscoveryProgress
        jobId="job-1"
        initialStatus="pending"
        onComplete={onComplete}
      />,
    );

    // Flush the initial poll() microtasks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOFT_THRESHOLD_MS);
    });

    expect(
      screen.getByText("Det tar längre tid än väntat, fortsätter…"),
    ).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    const callsAtSoft = tickDiscoveryMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(tickDiscoveryMock.mock.calls.length).toBeGreaterThan(callsAtSoft);
  });

  it("calls onComplete('failed') exactly once at ABSOLUTE_CEILING_MS for a genuinely stuck job (D-05)", async () => {
    const onComplete = vi.fn();
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

    render(
      <DiscoveryProgress
        jobId="job-1"
        initialStatus="pending"
        onComplete={onComplete}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ABSOLUTE_CEILING_MS);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("failed");
  });

  it("clears BOTH timers when a terminal status arrives before the soft threshold — no false failure (Pitfall 5)", async () => {
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onComplete).toHaveBeenCalledWith("done");
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Advance well past both the soft threshold and the absolute ceiling —
    // neither timer may fire now that the terminal branch has cleared them.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ABSOLUTE_CEILING_MS + POLL_MS);
    });

    expect(
      screen.queryByText("Det tar längre tid än väntat, fortsätter…"),
    ).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalledWith("failed");
  });
});

describe("DiscoveryProgress — decoupled status read (13-04 Task 1, GAP-1)", () => {
  beforeEach(() => {
    singleMock.mockReset();
    tickDiscoveryMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances the badge Analyserar -> Analyserar bilder from the DB read while tickDiscovery is STILL pending (never resolves in-test) — proves the read is not gated by inFlight", async () => {
    // The tick dispatch never resolves for the lifetime of this test — under
    // the OLD (gated) implementation, a status read behind `await
    // tickDiscovery(jobId)` would never run again after the first poll, so
    // the badge would freeze. The read must run on every interval tick
    // regardless of this pending dispatch.
    tickDiscoveryMock.mockImplementation(() => new Promise(() => {}));

    let call = 0;
    singleMock.mockImplementation(() => {
      call += 1;
      return Promise.resolve({
        data: {
          status: call === 1 ? "processing" : "vision_processing",
          processed_count: 3,
          candidate_count: 3,
          cap_candidates: 25,
          cost_sek_total: 0.5,
          cap_reached: false,
        },
      });
    });

    render(<DiscoveryProgress jobId="job-1" initialStatus="pending" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Analyserar")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByText("Analyserar bilder")).toBeInTheDocument();
  });

  it("keeps the tick dispatch in-flight-guarded (no overlapping dispatch) even though the read runs every tick", async () => {
    tickDiscoveryMock.mockImplementation(() => new Promise(() => {})); // never resolves
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(tickDiscoveryMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    });
    // The in-flight guard still protects the DISPATCH — a single still-pending
    // tick is never overlapped by a second dispatch.
    expect(tickDiscoveryMock).toHaveBeenCalledTimes(1);
    // But the READ ran on every one of those ticks — proof it is NOT gated
    // behind the in-flight dispatch guard.
    expect(singleMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("terminal branch still clears both timers and fires onComplete exactly once, even with a tick still pending (Pitfall 5 survives the split)", async () => {
    const onComplete = vi.fn();
    tickDiscoveryMock.mockImplementation(() => new Promise(() => {}));
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onComplete).toHaveBeenCalledWith("done");
    expect(onComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ABSOLUTE_CEILING_MS + POLL_MS);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
