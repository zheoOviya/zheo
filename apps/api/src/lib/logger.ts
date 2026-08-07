import winston from "winston";

// ============================================
// Observability (EOS 1.5): structured JSON logs
// Levels: ERROR, WARN, INFO, DEBUG
// ============================================

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export function createLogger(transports?: winston.transport[]) {
  return winston.createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    format: jsonFormat,
    defaultMeta: { service: "snakzap-api" },
    transports:
      transports ??
      [
        new winston.transports.Console({
          format: process.env.NODE_ENV === "test" ? winston.format.cli() : undefined,
        }),
      ],
  });
}

export const logger = createLogger();

export type Logger = winston.Logger;
