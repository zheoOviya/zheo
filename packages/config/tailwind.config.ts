import type { Config } from "tailwindcss";

export const snakZapPreset: Partial<Config> = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#0D9488",
          hover: "#0F766E",
          50: "#CCFBF1",
          100: "#99F6E4",
          200: "#5EEAD4",
          300: "#2DD4BF",
          400: "#14B8A6",
          500: "#0D9488",
          600: "#0F766E",
          700: "#115E59",
          800: "#134E4A",
          900: "#042F2E",
        },
        accent: {
          DEFAULT: "#F59E0B",
          50: "#FFFBEB",
          100: "#FEF3C7",
          200: "#FDE68A",
          300: "#FCD34D",
          400: "#FBBF24",
          500: "#F59E0B",
          600: "#D97706",
          700: "#B45309",
          800: "#92400E",
          900: "#78350F",
        },
        surface: {
          light: "#F0FDFA",
          dark: "#042F2E",
        },
      },
      keyframes: {
        "skeleton-teal": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
      },
      animation: {
        "skeleton-teal": "skeleton-teal 1.5s ease-in-out infinite",
      },
    },
  },
};

export default snakZapPreset;
