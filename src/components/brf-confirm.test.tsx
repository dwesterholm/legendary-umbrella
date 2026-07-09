// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrfMatchConfirmation } from "@/components/brf-confirm";

describe("BrfMatchConfirmation", () => {
  it("renders the locked heading, org.nr, and fiscal year", () => {
    render(
      <BrfMatchConfirmation
        orgNr="769600-1234"
        fiscalYear={2024}
        brfName="Brf Solkatten"
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    );

    expect(
      screen.getByText("Stämmer detta med din bostad?"),
    ).toBeInTheDocument();
    expect(screen.getByText("769600-1234")).toBeInTheDocument();
    expect(screen.getByText("2024")).toBeInTheDocument();
    expect(screen.getByText("Brf Solkatten")).toBeInTheDocument();
  });

  it("fires onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <BrfMatchConfirmation
        orgNr="769600-1234"
        fiscalYear={2024}
        brfName={null}
        onConfirm={onConfirm}
        onReject={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Ja, stämmer — analysera"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fires onReject when the reject button is clicked", () => {
    const onReject = vi.fn();
    render(
      <BrfMatchConfirmation
        orgNr="769600-1234"
        fiscalYear={2024}
        brfName={null}
        onConfirm={() => {}}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByText("Nej, ladda upp manuellt"));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("renders both buttons equally sized and reject as outline (equal-prominence check)", () => {
    render(
      <BrfMatchConfirmation
        orgNr="769600-1234"
        fiscalYear={2024}
        brfName={null}
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    );

    const confirmBtn = screen.getByText("Ja, stämmer — analysera");
    const rejectBtn = screen.getByText("Nej, ladda upp manuellt");

    // Both present, both visible (not disabled/hidden) — equal reachability.
    expect(confirmBtn).toBeVisible();
    expect(rejectBtn).toBeVisible();
    expect(rejectBtn).not.toBeDisabled();

    // Both share the h-11 px-6 sizing convention.
    expect(confirmBtn.className).toMatch(/h-11/);
    expect(confirmBtn.className).toMatch(/px-6/);
    expect(rejectBtn.className).toMatch(/h-11/);
    expect(rejectBtn.className).toMatch(/px-6/);

    // Reject is never ghost/smaller — must be the outline variant, never the
    // sage-filled confirm styling.
    expect(rejectBtn.className).not.toMatch(/bg-sage-600/);
  });

  it("does not render the ambiguous-match banner when no message is provided", () => {
    render(
      <BrfMatchConfirmation
        orgNr="769600-1234"
        fiscalYear={2024}
        brfName={null}
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    );

    expect(
      screen.queryByText(/kunde inte hitta en säker matchning/i),
    ).not.toBeInTheDocument();
  });
});
