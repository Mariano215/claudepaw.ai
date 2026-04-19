import pino from 'pino'

// Use pino-pretty only when stdout is a TTY (interactive terminal).
// Under launchd, stdout is redirected to a file and pino-pretty's worker
// thread can stall, causing log loss and event loop delays.
const usePretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: usePretty
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
})
