import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), "utf8");

const ROOT = "../../../../";
const readRoot = (rel: string) => read(ROOT + rel);

const countOf = (src: string, token: string) => src.split(token).length - 1;

const ADDRESSES = "../../app/addresses/page.tsx";
const CHECKOUT = "../../app/checkout/page.tsx";
const BILL_PANEL = "../../app/dine-in/menu/DineInBillRequestPanel.tsx";
const MENU_LIST = "../../app/dine-in/menu/DineInMenuList.tsx";
const SERVICE_PANEL = "../../app/dine-in/menu/DineInServiceRequestPanel.tsx";
const ERROR_PAGE = "../../app/error.tsx";
const GROUP_CART = "../../app/group-cart/page.tsx";
const NOT_FOUND = "../../app/not-found.tsx";
const ONBOARDING = "../../app/onboarding/page.tsx";
const ORDER_DETAIL = "../../app/orders/[id]/page.tsx";
const ORDERS = "../../app/orders/page.tsx";
const PROFILE = "../../app/profile/page.tsx";
const RESTAURANT_DETAIL = "../../app/restaurants/[id]/page.tsx";
const ACCOUNT_ENTRY = "../AccountEntry.tsx";
const APP_HEADER = "../AppHeader.tsx";
const CART_DRAWER = "../CartDrawer.tsx";
const CUSTOMIZATION_PICKER = "../CustomizationPicker.tsx";
const DIETARY_FILTER = "../DietaryFilter.tsx";
const GIFT_MODAL = "../GiftModal.tsx";
const GIFT_SUCCESS = "../GiftSuccess.tsx";
const GROUP_CART_VIEW = "../GroupCartView.tsx";
const MENU_ITEMS_LIST = "../MenuItemsList.tsx";
const PHONE_OTP = "../PhoneOtpAuthForm.tsx";
const QR_CODE = "../QrCode.tsx";
const RESTAURANT_CARD = "../RestaurantCard.tsx";
const TOAST_PROVIDER = "../ToastProvider.tsx";

const GLOBALS_CSS = "../../app/globals.css";
const OTP_INPUT = "../OtpInput.tsx";
const API = "../../lib/api.ts";
const STORE = "../../lib/store.ts";
const BOTTOM_NAV = "../../../../packages/ui/src/BottomNav.tsx";
const CLIENT_PROVIDERS = "../ClientProviders.tsx";
const SELF = "consumerTouchLayout.test.tsx";

// POLICY_1 additive safe-area contract: 12px / 80px base + dynamic inset.
const NAV_SAFE_PADDING = "pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]";
const RESERVED_SAFE_PADDING = "pb-[calc(5rem+env(safe-area-inset-bottom,0px))]";

const HOME_LINK_CLASS =
  "inline-flex min-h-touch min-h-9 items-center gap-1 rounded-full bg-white px-3.5";

// Exact A2b production sweep manifest: 25 files, consumer-only, class-only.
const FROZEN_MANIFEST = [
  "apps/consumer/app/addresses/page.tsx",
  "apps/consumer/app/checkout/page.tsx",
  "apps/consumer/app/dine-in/menu/DineInBillRequestPanel.tsx",
  "apps/consumer/app/dine-in/menu/DineInMenuList.tsx",
  "apps/consumer/app/dine-in/menu/DineInServiceRequestPanel.tsx",
  "apps/consumer/app/error.tsx",
  "apps/consumer/app/group-cart/page.tsx",
  "apps/consumer/app/not-found.tsx",
  "apps/consumer/app/onboarding/page.tsx",
  "apps/consumer/app/orders/[id]/page.tsx",
  "apps/consumer/app/orders/page.tsx",
  "apps/consumer/app/profile/page.tsx",
  "apps/consumer/app/restaurants/[id]/page.tsx",
  "apps/consumer/components/AccountEntry.tsx",
  "apps/consumer/components/AppHeader.tsx",
  "apps/consumer/components/CartDrawer.tsx",
  "apps/consumer/components/CustomizationPicker.tsx",
  "apps/consumer/components/DietaryFilter.tsx",
  "apps/consumer/components/GiftModal.tsx",
  "apps/consumer/components/GroupCartView.tsx",
  "apps/consumer/components/MenuItemsList.tsx",
  "apps/consumer/components/PhoneOtpAuthForm.tsx",
  "apps/consumer/components/QrCode.tsx",
  "apps/consumer/components/RestaurantCard.tsx",
  "apps/consumer/components/ToastProvider.tsx",
];

const FORBIDDEN_SWEEP_SURFACE: RegExp[] = [
  /^apps\/api\//,
  /^packages\//,
  /^apps\/consumer\/lib\//,
  /^apps\/admin\//,
  /^apps\/vendor\//,
  /^pnpm-lock\.yaml$/,
  /^\.github\//,
  /^e2e\//,
  /^apps\/consumer\/app\/globals\.css$/,
  /tailwind/,
];

// Tokens that would indicate a responsive/grid/overflow redesign rather than a
// class-only touch-target normalization.
const REDESIGN_TOKENS = [
  "grid-cols",
  "overflow-x-",
  "overflow-y-",
  "w-screen",
  "sm:",
  "md:",
  "lg:",
  "xl:",
  "2xl:",
];

describe("CT-1 44px utility contract (globals.css, no !important)", () => {
  it("defines .min-h-touch / .min-w-touch as 44px", () => {
    const css = read(GLOBALS_CSS);
    expect(css).toContain(".min-h-touch");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain(".min-w-touch");
    expect(css).toContain("min-width: 44px");
  });

  it("does not use !important on the touch utilities (otherwise precedence breaks)", () => {
    const css = read(GLOBALS_CSS);
    const block = css.slice(css.indexOf(".min-h-touch"), css.indexOf(".min-w-touch") + 120);
    expect(block).not.toContain("!important");
  });
});

describe("CT-2 representative standard actions use min-h-touch", () => {
  it("checkout slot + Continue Shopping", () => {
    const src = read(CHECKOUT);
    expect(countOf(src, "min-h-touch")).toBe(2);
    expect(src).toContain("min-h-touch rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors");
    expect(src).toContain("min-h-touch w-full py-2 text-sm text-neutral-400 hover:text-primary-600");
  });

  it("onboarding carousel actions", () => {
    const src = read(ONBOARDING);
    // Source literals: 4 controls (Skip/Back/Next/Get Started) + 1 dot template.
    // The dot template renders 3 buttons via SLIDES.map, so it contributes one
    // literal even though the runtime produces three 44x44 targets.
    expect(countOf(src, "min-h-touch")).toBe(5);
    expect(countOf(src, "min-w-touch")).toBe(1);
    expect(src).toContain("min-h-touch rounded-full px-4 py-2 text-sm font-semibold text-primary-600");
    expect(src).toContain("min-h-touch rounded-full border border-primary-500/30 px-5 py-2.5");
    expect(countOf(src, "min-h-touch rounded-full bg-primary-500 px-5 py-2.5 text-sm font-bold")).toBe(2);
    // The pagination dot template carries both 44px utilities.
    expect(countOf(src, "flex min-h-touch min-w-touch items-center justify-center")).toBe(1);
  });

  it("order history + profile + error/not-found actions", () => {
    expect(countOf(read(ORDERS), "min-h-touch")).toBe(6);
    expect(countOf(read(PROFILE), "min-h-touch")).toBe(3);
    expect(countOf(read(ERROR_PAGE), "min-h-touch")).toBe(1);
    expect(countOf(read(NOT_FOUND), "min-h-touch")).toBe(1);
    expect(read(ERROR_PAGE)).toContain("onClick={reset}");
  });

  it("back-home pills across addresses, group-cart and orders", () => {
    for (const file of [ADDRESSES, GROUP_CART, ORDERS]) {
      expect(read(file), `${file} pill link`).toContain(HOME_LINK_CLASS);
    }
  });
});

describe("CT-3 representative square/icon controls use min-h-touch + min-w-touch", () => {
  it("cart drawer quantity controls", () => {
    const src = read(CART_DRAWER);
    expect(countOf(src, "flex min-h-touch min-w-touch h-9 w-9 items-center justify-center rounded-full")).toBe(2);
    expect(countOf(src, "min-w-touch")).toBe(2);
  });

  it("dine-in quantity controls (h-7 w-7)", () => {
    const src = read(MENU_LIST);
    expect(countOf(src, "min-h-touch")).toBe(3);
    expect(countOf(src, "min-w-touch")).toBe(2);
    expect(countOf(src, "flex min-h-touch min-w-touch h-7 w-7 items-center justify-center")).toBe(2);
  });

  it("account avatar, brand mark, dine-in close and restaurant back controls", () => {
    expect(countOf(read(ACCOUNT_ENTRY), "min-w-touch")).toBe(1);
    expect(read(ACCOUNT_ENTRY)).toContain("flex min-h-touch min-w-touch h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br");
    expect(read(APP_HEADER)).toContain('className="flex min-h-touch items-center gap-2.5" aria-label="SnakZap home"');

    const closeClass = "flex min-h-touch min-w-touch h-10 w-10 items-center justify-center rounded-full text-neutral-400";
    expect(read(BILL_PANEL)).toContain(closeClass);
    expect(read(SERVICE_PANEL)).toContain(closeClass);
    expect(read(RESTAURANT_DETAIL)).toContain("absolute left-4 top-4 flex min-h-touch min-w-touch h-10 w-10 items-center justify-center");
    expect(read(MENU_ITEMS_LIST)).toContain("flex min-h-touch min-w-touch h-9 w-9 shrink-0 items-center justify-center");
  });

  it("remaining manifest targets keep their normalized controls", () => {
    const orderDetail = read(ORDER_DETAIL);
    expect(countOf(orderDetail, "min-h-touch")).toBe(2);
    expect(orderDetail).toContain("min-h-touch mb-4 inline-flex items-center gap-1");
    expect(orderDetail).toContain("min-h-touch mt-4 rounded-full bg-green-600");

    const picker = read(CUSTOMIZATION_PICKER);
    expect(countOf(picker, "min-h-touch")).toBe(2);
    expect(picker).toContain("min-h-touch flex-1 rounded-full border border-primary-500/30 py-2.5");
    expect(picker).toContain("min-h-touch flex flex-1 items-center justify-center gap-2 rounded-full py-2.5");

    expect(read(DIETARY_FILTER)).toContain("min-h-touch rounded-full px-4 py-1.5 text-sm font-medium transition-colors");
    expect(read(GIFT_MODAL)).toContain("min-h-touch mt-1 w-full rounded-xl border");

    const groupCart = read(GROUP_CART_VIEW);
    expect(countOf(groupCart, "min-h-touch")).toBe(3);
    expect(countOf(groupCart, "min-h-touch rounded-full border border-primary-500/30 px-4 py-2 text-sm font-medium")).toBe(2);

    const qr = read(QR_CODE);
    expect(countOf(qr, "min-h-touch")).toBe(3);
    expect(qr).toContain("min-h-touch flex-1 rounded-full bg-primary-500 py-2.5");
    expect(qr).toContain("min-h-touch mt-4 text-sm text-neutral-400");

    expect(read(TOAST_PROVIDER)).toContain("min-h-touch shrink-0 rounded-full bg-primary-500 px-3 py-1");
  });
});

describe("CT-4 GiftSuccess inline prose URL remains excluded", () => {
  it("does not migrate GiftSuccess onto the touch utilities", () => {
    const src = read(GIFT_SUCCESS);
    expect(countOf(src, "min-h-touch")).toBe(0);
    expect(countOf(src, "min-w-touch")).toBe(0);

    // Existing compliant controls keep their explicit 44px policy.
    expect(countOf(src, "min-h-[44px]")).toBe(3);

    // The inline prose URL anchor is a text link, not a migration target.
    expect(src).toContain("mt-2 block truncate text-xs text-primary-700/70 underline-offset-2 hover:underline");
    const anchorBlock = src.slice(src.indexOf("href={link}"), src.indexOf("</a>"));
    expect(anchorBlock).not.toContain("min-h-touch");
    expect(anchorBlock).not.toContain("min-w-touch");
  });

  it("keeps GiftSuccess out of the A2b production manifest", () => {
    expect(FROZEN_MANIFEST).not.toContain("apps/consumer/components/GiftSuccess.tsx");
  });
});

describe("CT-5 onboarding pagination dots expose a 44x44 hit box with preserved visuals", () => {
  it("wraps each decorative dot in a 44x44 button without overlapping hit regions", () => {
    const src = read(ONBOARDING);

    // One dot template inside SLIDES.map produces the three tab buttons, each an
    // outer hit box carrying both 44px utilities.
    expect(countOf(src, 'role="tab"')).toBe(1);
    expect(src).toContain("SLIDES.map((slide, i) => (");
    expect(countOf(src, "flex min-h-touch min-w-touch items-center justify-center")).toBe(1);
    expect(countOf(src, "min-w-touch")).toBe(1);

    // Visual geometry is preserved on a decorative, aria-hidden inner span.
    expect(src).toContain('aria-hidden="true"');
    expect(src).toContain("h-2.5 rounded-full transition-all motion-reduce:transition-none");
    expect(src).toContain('i === index ? "w-6 bg-primary-500" : "w-2.5 bg-primary-500/30"');
  });

  it("retains the tablist semantics and goTo handler contract", () => {
    const src = read(ONBOARDING);
    expect(src).toContain('role="tablist"');
    expect(src).toContain('aria-label="Slides"');
    expect(src).toContain("aria-selected={i === index}");
    expect(src).toContain("onClick={() => goTo(i)}");
    expect(src).toContain("`Go to slide ${i + 1}: ${slide.title}`");
  });

  it("protects the bounded two-row layout amendment (dots own full-width row)", () => {
    const src = read(ONBOARDING);
    // Nav wraps instead of forcing the dots to compete with Back/Next on one row.
    expect(src).toContain("flex flex-wrap items-center justify-between gap-4 p-6");
    // Dots take their own full-width, centered row after Back/Next/Get Started.
    expect(src).toContain("order-last flex w-full items-center justify-center gap-2");
  });
});

describe("CT-6 quantity controls satisfy 44x44", () => {
  it("cart drawer and dine-in quantity +/- controls carry both utilities", () => {
    const drawer = read(CART_DRAWER);
    expect(countOf(drawer, "flex min-h-touch min-w-touch h-9 w-9 items-center justify-center rounded-full")).toBe(2);

    const dineIn = read(MENU_LIST);
    expect(countOf(dineIn, "flex min-h-touch min-w-touch h-7 w-7 items-center justify-center")).toBe(2);

    expect(countOf(read(MENU_ITEMS_LIST), "flex min-h-touch min-w-touch h-9 w-9 shrink-0 items-center justify-center")).toBe(1);
  });
});

describe("CT-7 CartDrawer Remove/Clear satisfy policy", () => {
  it("carries min-h-touch on Remove and Clear Cart without further change", () => {
    const src = read(CART_DRAWER);
    expect(src).toContain("min-h-touch shrink-0 text-xs text-neutral-400");
    expect(src).toContain("min-h-touch w-full py-2 text-xs text-neutral-400");
    expect(src).toContain("Remove");
    expect(src).toContain("Clear Cart");
    // Place Order / Start Group Order already use explicit 44px.
    expect(countOf(src, "min-h-[44px]")).toBe(2);
  });
});

describe("CT-8 checkout slot + Continue Shopping compliant; radios unchanged", () => {
  it("normalizes only the slot selector and the continue control", () => {
    const src = read(CHECKOUT);
    expect(countOf(src, "min-h-touch")).toBe(2);
    expect(src).toContain("min-h-touch rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors");
    expect(src).toContain("min-h-touch w-full py-2 text-sm text-neutral-400 hover:text-primary-600");
    expect(src).toContain("Continue Shopping");
    expect(src).toContain("setShowGrid(false);");
  });

  it("leaves the two checkout radios untouched", () => {
    const src = read(CHECKOUT);
    expect(countOf(src, 'className="h-4 w-4 accent-primary-500"')).toBe(2);
    for (const line of src.split("\n")) {
      if (line.includes("h-4 w-4 accent-primary-500")) {
        expect(line).not.toContain("min-h-touch");
        expect(line).not.toContain("min-w-touch");
      }
    }
  });
});

describe("CT-9 no responsive/grid/overflow redesign in the authorized manifest", () => {
  it("never attaches a touch utility to a responsive/grid/overflow token", () => {
    for (const rel of FROZEN_MANIFEST) {
      const src = readRoot(rel);
      for (const line of src.split("\n")) {
        if (line.includes("min-h-touch") || line.includes("min-w-touch")) {
          for (const token of REDESIGN_TOKENS) {
            expect(line, `${rel} redesign token ${token}`).not.toContain(token);
          }
        }
      }
      expect(src, `${rel} horizontal overflow smell`).not.toContain("overflow-x-");
      expect(src, `${rel} viewport-width smell`).not.toContain("w-screen");
    }
  });

  it("retains representative frozen structural invariants", () => {
    expect(read(CHECKOUT)).toContain("grid-cols-4");
    expect(read(CHECKOUT)).toContain("space-y-6");
    expect(read(CART_DRAWER)).toContain("overflow-auto");
    expect(read(CART_DRAWER)).toContain("overflow-hidden");
    expect(read(PROFILE)).toContain("grid-cols-4");
    expect(read(PROFILE)).toContain("grid-cols-2");
    expect(read(ORDERS)).toContain("space-y-3");
    expect(read(RESTAURANT_CARD)).toContain("overflow-hidden");
  });
});

describe("CT-10 shared BottomNav additive safe-area contract", () => {
  it("keeps BottomNav fixed and uses the additive 12px + safe-area padding", () => {
    const src = read(BOTTOM_NAV);
    expect(src).toContain("fixed inset-x-0 bottom-0 z-50");
    expect(src).toContain("pointer-events-none px-4");
    expect(src).toContain(NAV_SAFE_PADDING);
    // The old source-order-dependent pair must be gone.
    expect(src).not.toContain("pb-safe");
    expect(src).not.toContain("pb-3");
  });

  it("adds no touch utilities and keeps the 44px min-h-11 link anchor", () => {
    const src = read(BOTTOM_NAV);
    expect(src).not.toContain("min-h-touch");
    expect(src).not.toContain("min-w-touch");
    // Existing 44px anchor policy remains the compliant path here.
    expect(src).toContain("relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5");
  });

  it("reserves 80px + safe-area for non-full-screen Consumer pages", () => {
    const src = read(CLIENT_PROVIDERS);
    expect(src).toContain(RESERVED_SAFE_PADDING);
    expect(src).not.toContain("pb-20");
  });

  it("keeps BottomNav out of the A2b production manifest", () => {
    expect(FROZEN_MANIFEST.some((rel) => rel.includes("BottomNav"))).toBe(false);
  });
});

describe("CT-11 A2a OTP semantics preserved; OtpInput untouched", () => {
  it("retains the OtpInput a11y contract from A2a", () => {
    const src = read(OTP_INPUT);
    expect(src).toContain('role="group"');
    expect(src).toContain('aria-labelledby="otp-group-label"');
    expect(src).toContain('id="otp-group-label"');
    expect(src).toContain("aria-label={`Digit ${idx + 1} of ${length}`}");
    expect(src).toContain("aria-invalid={error ? true : undefined}");
    expect(src).toContain('aria-describedby={error ? "otp-error" : undefined}');
    expect(src).toContain('id="otp-error"');
    expect(src).toContain('role="alert"');
    expect(src).toContain('inputMode="numeric"');
    expect(src).toContain('autoComplete="one-time-code"');
  });

  it("was not touched by the A2b class-only sweep", () => {
    const src = read(OTP_INPUT);
    expect(countOf(src, "min-h-touch")).toBe(0);
    expect(countOf(src, "min-w-touch")).toBe(0);
    expect(FROZEN_MANIFEST).not.toContain("apps/consumer/components/OtpInput.tsx");
    // The only OTP-adjacent A2b target is the PhoneOtpAuthForm back control.
    expect(countOf(read(PHONE_OTP), "min-h-touch")).toBe(1);
    expect(read(PHONE_OTP)).toContain("min-h-touch text-sm text-primary-600 hover:text-primary-700");
  });
});

describe("CT-12 no fetch/auth/payment/business behavior change", () => {
  it("preserves the api.ts transport + payment contract statically", () => {
    const src = read(API);
    expect(src).toContain('cache: "no-store"');
    expect(src).toContain('success: boolean;');
    expect(src).toContain('error: { code: string; message: string } | null;');
    expect(src).toContain('export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet" | "cod";');
    expect(src).toContain("/api/v1/payments/create-order");
    expect(src).toContain("/api/v1/payments/webhook");
    expect(src).toContain("export async function createPaymentOrder(");
    expect(src).toContain("export async function simulatePaymentWebhook(");
  });

  it("preserves the auth store endpoints and in-memory token contract statically", () => {
    const src = read(STORE);
    expect(src).toContain("/api/v1/auth/consumer/send-otp");
    expect(src).toContain("/api/v1/auth/consumer/verify-otp");
    expect(src).toContain("/api/v1/auth/refresh");
    expect(src).toContain("/api/v1/auth/me");
    expect(src).toContain("/api/v1/auth/logout");
    expect(src).toContain("let refreshInFlight: Promise<boolean> | null = null;");
    // Access token stays in memory only (no localStorage/sessionStorage write).
    expect(src).not.toContain("localStorage.setItem");
    expect(src).not.toContain("sessionStorage.setItem");
  });

  it("leaves the transport layers out of the class-only sweep", () => {
    expect(countOf(read(API), "min-h-touch")).toBe(0);
    expect(countOf(read(STORE), "min-h-touch")).toBe(0);
    expect(FROZEN_MANIFEST).not.toContain("apps/consumer/lib/api.ts");
    expect(FROZEN_MANIFEST).not.toContain("apps/consumer/lib/store.ts");
  });

  it("does not itself introduce network or business mutation", () => {
    const src = read(SELF);
    const importBlock = src
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import "));
    expect(importBlock.length).toBeGreaterThan(0);
    for (const line of importBlock) {
      expect(line, `import line ${line}`).toMatch(/from "(node:(fs|url)|vitest)"/);
    }
    const fragments = [
      ["child", "_process"].join(""),
      ["exec", "Sync"].join(""),
      ["require", "("].join(""),
    ];
    for (const fragment of fragments) {
      expect(src, `self dependency ${fragment}`).not.toContain(fragment);
    }
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bgit\b/);
  });
});

describe("CT-13 no Admin/Vendor/shared-UI scope expansion", () => {
  it("CT-13A RestaurantCard special case removes only !min-h-10", () => {
    const src = read(RESTAURANT_CARD);
    expect(countOf(src, "min-h-touch")).toBe(2);
    expect(countOf(src, "min-w-touch")).toBe(0);
    expect(src, "no important min-height remains").not.toContain("!min-h-");
    expect(src).toContain("btn-outline mt-3 w-full min-h-touch !px-4 !py-2 !text-xs");
    expect(src).toContain('className="min-h-touch ml-3 shrink-0 rounded-full bg-primary-500 px-4 py-1.5');
  });

  it("CT-13B freezes the exact 25-file consumer-only production manifest", () => {
    expect(FROZEN_MANIFEST.length).toBe(25);
    expect(new Set(FROZEN_MANIFEST).size).toBe(FROZEN_MANIFEST.length);
    for (const rel of FROZEN_MANIFEST) {
      expect(rel.startsWith("apps/consumer/"), `manifest path ${rel}`).toBe(true);
    }
    expect(FROZEN_MANIFEST.filter((rel) => countOf(readRoot(rel), "min-h-touch") > 0).length).toBe(25);
  });

  it("CT-13C never points the sweep manifest at a forbidden surface", () => {
    for (const rel of FROZEN_MANIFEST) {
      for (const re of FORBIDDEN_SWEEP_SURFACE) {
        expect(rel, `forbidden surface ${rel}`).not.toMatch(re);
      }
    }
  });
});
