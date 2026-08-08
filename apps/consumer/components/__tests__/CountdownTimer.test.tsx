import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { CountdownTimer } from "@snakzap/ui";

describe("CountdownTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders initial countdown in MM:SS format", () => {
    render(<CountdownTimer targetSeconds={120} />);
    expect(screen.getByText("02:00")).toBeInTheDocument();
  });

  it("counts down every second", () => {
    render(<CountdownTimer targetSeconds={120} />);
    expect(screen.getByText("02:00")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("01:55")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(screen.getByText("01:40")).toBeInTheDocument();
  });

  it("stops at 00:00 and does not go negative", () => {
    render(<CountdownTimer targetSeconds={5} />);
    expect(screen.getByText("00:05")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("00:00")).toBeInTheDocument();
  });

  it("shows green color when under 30% of target time has elapsed", () => {
    render(<CountdownTimer targetSeconds={100} />);
    expect(screen.getByText("01:40").className).toContain("text-urgency-green");

    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.getByText("01:20").className).toContain("text-urgency-green");
  });

  it("shows amber color between 30-70% elapsed", () => {
    render(<CountdownTimer targetSeconds={100} />);

    act(() => {
      vi.advanceTimersByTime(35000);
    });
    const text = screen.getByText("01:05");
    expect(text.className).toContain("text-urgency-amber");
  });

  it("shows red color when over 70% elapsed", () => {
    render(<CountdownTimer targetSeconds={100} />);

    act(() => {
      vi.advanceTimersByTime(75000);
    });
    const text = screen.getByText("00:25");
    expect(text.className).toContain("text-urgency-red");
  });

  it("calls onExpire when countdown reaches zero", () => {
    const onExpire = vi.fn();
    render(<CountdownTimer targetSeconds={3} onExpire={onExpire} />);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(screen.getByText("00:00")).toBeInTheDocument();
  });

  it("supports minutes display", () => {
    render(<CountdownTimer targetSeconds={3661} />);
    expect(screen.getByText("61:01")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<CountdownTimer targetSeconds={60} className="text-lg" />);
    const text = screen.getByText("01:00");
    expect(text.className).toContain("text-lg");
  });
});
