"use client";

// Keyboard bypass control rendered ahead of repeated brand/account chrome.
// It targets the post-header "main-content" sentinel emitted by AppHeader and,
// on the home route, by the page's inline header. Uses the existing .skip-link
// utility (visually hidden until focused).
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="skip-link"
      onClick={() => {
        document.getElementById("main-content")?.focus();
      }}
    >
      Skip to main content
    </a>
  );
}
