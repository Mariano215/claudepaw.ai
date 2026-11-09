import pino from 'pino'

// Use pino-pretty only when stdout is a TTY (interactive terminal).
// Under launchd, stdout is redirected to a file and pino-pretty's worker
// thread can stall, causing log loss and event loop delays.
const usePretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production'

// LOG_TO_STDERR=1: redirect pino to stderr so stdout stays clean for data output.
// Used when the process runs as a subprocess whose stdout is a JSON data channel
// (e.g. rentcast-cli spawned by broker-market-deltas collector). Without this,
// pino's SonicBoom async FD writes interleave with process.stdout.write() at the
// 64KB stream highWaterMark boundary, embedding log lines inside the JSON emit.
const dest = !usePretty && process.env.LOG_TO_STDERR === '1'
  ? pino.destination({ dest: 2, sync: true })
  : undefined

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: usePretty
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  dest,
)
