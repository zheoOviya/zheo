import { describe, it, expect } from "vitest";

describe("MenuItem image_url field", () => {
  it("MenuItem type includes image_url as string | null", () => {
    const item = {
      id: "test-id",
      restaurant_id: "r1",
      name: "Test",
      price: 100,
      image_url: "https://example.com/img.jpg",
      dietary_tags: {},
      customizations: [],
      is_available: true,
      spice_level: 1,
    };
    expect(item.image_url).toBe("https://example.com/img.jpg");
    const noImage = { ...item, image_url: null };
    expect(noImage.image_url).toBeNull();
  });
});
