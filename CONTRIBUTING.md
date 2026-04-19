# Contributing to ClaudePaw

Thanks for your interest in contributing.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run `npm install`
4. Copy `.env.example` to `.env` and fill in your values
5. Run `npm run setup` for the interactive wizard
6. Run `npm run dev` to start in development mode

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm test` to verify tests pass
4. Run `npx tsc --noEmit` to verify types
5. Commit with a clear message describing the change
6. Open a pull request

## Code Style

- TypeScript strict mode
- No `any` types where avoidable
- Timestamps in milliseconds (never seconds)
- SQLite with WAL mode
- Pino for logging

## Reporting Issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version)
