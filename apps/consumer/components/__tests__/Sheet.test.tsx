import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Sheet } from "@snakzap/ui";

describe("Sheet", () => {
  it("renders nothing when closed", () => {
    render(
      <Sheet open={false} onClose={vi.fn()} title="Test Sheet">
        <p>Content</p>
      </Sheet>,
    );
    expect(screen.queryByText("Test Sheet")).not.toBeInTheDocument();
  });

  it("renders title and content when open", async () => {
    render(
      <Sheet open={true} onClose={vi.fn()} title="Quick Add">
        <p>Menu item 1</p>
      </Sheet>,
    );
    await waitFor(() => {
      expect(screen.getByText("Quick Add")).toBeInTheDocument();
    });
    expect(screen.getByText("Menu item 1")).toBeInTheDocument();
  });

  it("calls onClose when backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} onClose={onClose} title="Test">
        <p>Content</p>
      </Sheet>,
    );
    await waitFor(() => {
      expect(screen.getByText("Test")).toBeInTheDocument();
    });
    const backdrop = document.querySelector(".bg-black\\/40");
    expect(backdrop).toBeInTheDocument();
    if (backdrop) {
      fireEvent.click(backdrop);
      await waitFor(() => {
        expect(onClose).toHaveBeenCalled();
      });
    }
  });

  it("renders drag handle at top", async () => {
    render(
      <Sheet open={true} onClose={vi.fn()} title="Sheet">
        <p>Body</p>
      </Sheet>,
    );
    await waitFor(() => {
      const handle = document.querySelector(".h-1.w-10.rounded-full");
      expect(handle).toBeInTheDocument();
    });
  });

  it("renders without title when not provided", async () => {
    render(
      <Sheet open={true} onClose={vi.fn()}>
        <p>Content only</p>
      </Sheet>,
    );
    await waitFor(() => {
      expect(screen.getByText("Content only")).toBeInTheDocument();
    });
  });

  it("applies overflow hidden when open", async () => {
    render(
      <Sheet open={true} onClose={vi.fn()}>
        <p>Content</p>
      </Sheet>,
    );
    await waitFor(() => {
      expect(document.body.style.overflow).toBe("hidden");
    });
  });
});
