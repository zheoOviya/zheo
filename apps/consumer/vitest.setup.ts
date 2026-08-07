import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import toast from "react-hot-toast";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  toast.remove();
  cleanup();
});

// jsdom does not implement window.matchMedia. ToasterHost depends on it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
