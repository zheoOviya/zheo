import type { Config } from "tailwindcss";
import { snakZapPreset } from "@snakzap/config/tailwind";

export default {
  presets: [snakZapPreset],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
} satisfies Config;
