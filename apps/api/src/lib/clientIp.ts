import { isIP } from "node:net";

// ============================================
// AUTH-G7: canonical trusted client-IP.
//
// The application previously trusted exactly one proxy hop
// (`app.set("trust proxy", 1)`) unconditionally, which made `req.ip`
// spoofable when the API is directly reachable or when the fronting
// proxy preserves a client-supplied `X-Forwarded-For`.
//
// Trust is now an explicit allowlist of proxy IPs/CIDRs. Express only
// consults forwarded headers past hops that match the allowlist; every
// other peer is terminal. `clientIp()` never parses forwarded headers
// itself - it reads the already trust-evaluated `req.ip` and only
// normalizes IPv4-mapped IPv6 (`::ffff:1.2.3.4` -> `1.2.3.4`).
// ============================================

/** Shape sufficient to derive the client IP (structurally matches Express Request). */
export interface ClientIpSource {
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface TrustedProxyConfig {
  /** True only when TRUSTED_PROXIES is present and non-blank. */
  declared: boolean;
  /** True when no proxy is trusted ("none", blank, or unset). */
  disabled: boolean;
  /** Validated proxy IP/CIDR entries (empty when disabled or on error). */
  allowlist: string[];
  /** First parse/validation error, or null. */
  error: string | null;
  raw: string | undefined;
}

/** Strip an IPv4-mapped IPv6 prefix and reject empty results. */
export function normalizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const mapped = ip.replace(/^::ffff:/i, "");
  return mapped.length > 0 ? mapped : undefined;
}

/** Canonical trusted client IP from Express's trust-evaluated `req.ip`. */
export function clientIp(req: ClientIpSource): string {
  return (
    normalizeIp(req.ip) ??
    normalizeIp(req.socket?.remoteAddress) ??
    "unknown"
  );
}

function validateEntry(entry: string): string | null {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    return isIP(entry) === 0 ? `"${entry}" is not a valid IP address` : null;
  }
  const addr = entry.slice(0, slash);
  const prefixStr = entry.slice(slash + 1);
  const version = isIP(addr);
  if (version === 0) return `"${entry}" has an invalid IP address`;
  if (!/^[0-9]+$/.test(prefixStr)) {
    return `"${entry}" has an invalid prefix length`;
  }
  const prefix = Number.parseInt(prefixStr, 10);
  const max = version === 4 ? 32 : 128;
  if (prefix < 1 || prefix > max) {
    return `"${entry}" prefix length must be between 1 and ${max}`;
  }
  return null;
}

/**
 * Parse TRUSTED_PROXIES into an explicit, validated model.
 *
 *   undefined / blank -> not declared (non-production: trust nothing)
 *   none              -> declared, trust nothing (valid in production)
 *   <ip|cidr>[,...]   -> declared, explicit allowlist
 *   invalid / /0       -> error (fail-closed at startup)
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxyConfig {
  if (raw === undefined) {
    return { declared: false, disabled: true, allowlist: [], error: null, raw };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { declared: false, disabled: true, allowlist: [], error: null, raw };
  }
  if (trimmed.toLowerCase() === "none") {
    return { declared: true, disabled: true, allowlist: [], error: null, raw };
  }

  const allowlist: string[] = [];
  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    if (entry === "") {
      return {
        declared: true,
        disabled: false,
        allowlist: [],
        error: "empty entry in TRUSTED_PROXIES",
        raw,
      };
    }
    const err = validateEntry(entry);
    if (err) {
      return { declared: true, disabled: false, allowlist: [], error: err, raw };
    }
    allowlist.push(entry);
  }
  return { declared: true, disabled: false, allowlist, error: null, raw };
}

/** Value for `app.set("trust proxy", ...)`: an allowlist array, or false to trust nothing. */
export function trustProxyValue(cfg: TrustedProxyConfig): false | string[] {
  if (cfg.error || cfg.disabled || cfg.allowlist.length === 0) return false;
  return cfg.allowlist;
}
