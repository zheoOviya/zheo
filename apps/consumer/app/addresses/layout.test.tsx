import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AddressesLayout, { metadata } from "./layout";

describe("AddressesLayout", () => {
  it("sets the per-page title metadata", () => {
    expect(metadata.title).toBe("Saved Addresses");
  });

  it("renders children through the layout", () => {
    render(
      <AddressesLayout>
        <p>Saved Addresses content</p>
      </AddressesLayout>,
    );

    expect(screen.getByText("Saved Addresses content")).toBeDefined();
  });
});
