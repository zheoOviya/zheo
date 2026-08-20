import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

export const CONSUMER = "http://localhost:3000";
export const VENDOR = "http://localhost:3002";
export const ADMIN = "http://localhost:3003";

export const OUT = "/workspace/qa/output";

export function setupDirs(role, key) {
  const dir = path.join(OUT, role, String(key));
  const shots = path.join(dir, "screenshots");
  fs.mkdirSync(shots, { recursive: true });
  const logFile = path.join(dir, "run.log");
  fs.writeFileSync(logFile, "");
  return { dir, shots, logFile };
}

export function makeLogger(logFile, tag) {
  return function log(msg) {
    const line = `[${new Date().toISOString()}] [${tag}] ${msg}`;
    fs.appendFileSync(logFile, line + "\n");
    console.log(line);
  };
}

export async function newAuditedPage(browser, { viewport, log, shots, prefix }) {
  const page = await browser.newPage({ viewport });
  const issues = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      const text = m.text();
      issues.push(`console.error: ${text}`);
      log(`CONSOLE_ERROR: ${text}`);
    }
  });
  page.on("pageerror", (e) => {
    issues.push(`pageerror: ${e.message}`);
    log(`PAGE_ERROR: ${e.message}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.includes("localhost") || u.includes("monkeycode")) {
      const msg = `requestfailed: ${u} ${r.failure()?.errorText || ""}`;
      issues.push(msg);
      log(`REQUEST_FAILED: ${u} ${r.failure()?.errorText || ""}`);
    }
  });
  const shot = async (name) => {
    const safe = String(name).replace(/[^a-zA-Z0-9-_]+/g, "_");
    const p = path.join(shots, `${safe}.png`);
    try {
      await page.screenshot({ path: p, fullPage: true });
      log(`SCREENSHOT: ${p}`);
    } catch (e) {
      log(`SCREENSHOT_FAIL ${name}: ${e.message}`);
    }
  };
  return { page, issues, shot };
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function appendJsonLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}
