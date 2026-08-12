"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// I-01 Onboarding carousel - first-run experience shown before the home feed.
// Three swipable slides (Order Ahead / Real-Time Alerts / No Delivery Fees).
// Once dismissed (Skip or Get Started) the flag is stored in localStorage and
// the user is sent to the home page; returning visits skip straight past.
// A11y: role="region" + aria-roledescription="carousel", keyboard controls,
// reduced-motion safe transitions.

const ONBOARDING_FLAG = "snakzap_onboarded";

interface Slide {
  id: string;
  title: string;
  description: string;
  icon: "ahead" | "alerts" | "fees";
}

const SLIDES: Slide[] = [
  {
    id: "order-ahead",
    title: "Order Ahead",
    description:
      "Browse restaurants near you, pick your favorites, and skip the line. Your food is ready the moment you arrive.",
    icon: "ahead",
  },
  {
    id: "real-time-alerts",
    title: "Real-Time Alerts",
    description:
      "Live updates from kitchen to counter. Know exactly when your order is ready - no more guessing or waiting.",
    icon: "alerts",
  },
  {
    id: "no-delivery-fees",
    title: "No Delivery Fees",
    description:
      "Pickup only, so every rupee goes toward your meal. Pay what you see, eat what you order.",
    icon: "fees",
  },
];

function SlideIcon({ icon }: { icon: Slide["icon"] }) {
  if (icon === "ahead") {
    return (
      <svg className="h-16 w-16 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
      </svg>
    );
  }
  if (icon === "alerts") {
    return (
      <svg className="h-16 w-16 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
      </svg>
    );
  }
  return (
    <svg className="h-16 w-16 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(ONBOARDING_FLAG) === "1") {
        router.replace("/");
      }
    } catch {
      // localStorage unavailable - still show onboarding.
    }
  }, [router]);

  const goTo = useCallback((i: number) => {
    setIndex(Math.max(0, Math.min(SLIDES.length - 1, i)));
  }, []);

  const next = useCallback(() => goTo(index + 1), [goTo, index]);
  const prev = useCallback(() => goTo(index - 1), [goTo, index]);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_FLAG, "1");
    } catch {
      // No-op: keep navigating even if storage is blocked.
    }
    router.push("/");
  }, [router]);

  const isLast = index === SLIDES.length - 1;

  return (
    <main
      role="region"
      aria-roledescription="carousel"
      aria-label="Welcome to SnakZap"
      className="flex min-h-dvh flex-col bg-surface-light"
    >
      <header className="flex justify-end p-5">
        <button
          type="button"
          onClick={finish}
          className="rounded-full px-4 py-2 text-sm font-semibold text-primary-600 hover:bg-primary-500/10"
        >
          Skip
        </button>
      </header>

      <div
        className="relative flex-1 overflow-hidden"
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          if (touchStartX.current === null) return;
          const delta =
            (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
          touchStartX.current = null;
          if (Math.abs(delta) < 40) return;
          if (delta < 0) next();
          else prev();
        }}
      >
        <div
          className="flex h-full transition-transform duration-500 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {SLIDES.map((slide, i) => (
            <section
              key={slide.id}
              aria-label={`Slide ${i + 1} of ${SLIDES.length}: ${slide.title}`}
              aria-hidden={i !== index}
              className="flex w-full shrink-0 flex-col items-center justify-center gap-6 px-8 text-center"
            >
              <SlideIcon icon={slide.icon} />
              <h1 className="text-3xl font-bold text-primary-700">
                {slide.title}
              </h1>
              <p className="max-w-sm text-base leading-relaxed text-neutral-500">
                {slide.description}
              </p>
            </section>
          ))}
        </div>
      </div>

      <nav
        aria-label="Carousel navigation"
        className="flex items-center justify-between gap-4 p-6"
      >
        <button
          type="button"
          onClick={prev}
          disabled={index === 0}
          aria-label="Previous slide"
          className="rounded-full border border-primary-500/30 px-5 py-2.5 text-sm font-semibold text-primary-700 hover:bg-surface-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          &larr; Back
        </button>

        <div className="flex items-center gap-2" role="tablist" aria-label="Slides">
          {SLIDES.map((slide, i) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Go to slide ${i + 1}: ${slide.title}`}
              onClick={() => goTo(i)}
              className={`h-2.5 rounded-full transition-all motion-reduce:transition-none ${
                i === index ? "w-6 bg-primary-500" : "w-2.5 bg-primary-500/30"
              }`}
            />
          ))}
        </div>

        {isLast ? (
          <button
            type="button"
            onClick={finish}
            className="rounded-full bg-primary-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover"
          >
            Get Started
          </button>
        ) : (
          <button
            type="button"
            onClick={next}
            aria-label="Next slide"
            className="rounded-full bg-primary-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover"
          >
            Next
          </button>
        )}
      </nav>
    </main>
  );
}
