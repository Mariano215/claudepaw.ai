#!/usr/bin/env node

/**
 * CLI for managing ClaudePaw scheduled tasks.
 *
 * Usage:
 *   tsx src/schedule-cli.ts create "<prompt>" "<cron>" <chat_id>
 *   tsx src/schedule-cli.ts list
 *   tsx src/schedule-cli.ts delete <id>
 *   tsx src/schedule-cli.ts pause <id>
 *   tsx src/schedule-cli.ts resume <id>
 *
 * Silent mode:
 *   Prefix the prompt with [silent] to suppress the scheduler's Telegram
 *   notifications (preamble + result). Use for tasks where the agent handles
 *   its own output (e.g. social-cli notify sends drafts with buttons).
 *
 *   Example:
 *     tsx src/schedule-cli.ts create "[silent] Write an article about X" "0 9 * * 1" 123456789
 */

import { randomUUID } from 'node:crypto'
import cronParser from 'cron-parser'
import {
  initDatabase,
  createTask,
  listTasks,
  deleteTask,
  pauseTask,
  resumeTask,
  getTask,
} from './db.js'
import { computeNextRun } from './scheduler.js'

// Ensure tables exist
initDatabase()

const args = process.argv.slice(2)
const command = args[0]

/**
 * Generate a kebab-case slug from a prompt string.
 * Takes the first few meaningful words, strips noise, returns something like "summarize-my-emails".
 */
function slugify(prompt: string): string {
  const stripped = prompt
    .replace(/^\[silent\]\s*/i, '')       // remove [silent] prefix
    .replace(/^(you are the|run the|run a)\s+/i, '') // strip common preambles
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')        // keep only alphanumeric + spaces
    .trim()

  const words = stripped.split(/\s+/).filter(Boolean).slice(0, 4)
  return words.join('-') || randomUUID().slice(0, 8)
}

function usage(): void {
  console.log(`ClaudePaw Scheduler CLI

Commands:
  create "<prompt>" "<cron>" <chat_id> [id] [project-id]   Create a new scheduled task
  list                                         List all scheduled tasks
  delete <id>                                  Delete a task
  pause <id>                                   Pause a task
  resume <id>                                  Resume a paused task

The [id] parameter is optional. If omitted, a slug is auto-generated from
the prompt (e.g. "Summarize my emails" -> "summarize-my-emails").

Examples:
  tsx src/schedule-cli.ts create "Summarize my emails" "0 9 * * *" 123456789
  tsx src/schedule-cli.ts create "Run backups" "0 6 * * *" 123456789 daily-backup
  tsx src/schedule-cli.ts list
  tsx src/schedule-cli.ts pause abc123
`)
}

function formatTimestamp(unix: number | null): string {
  if (!unix) return '-'
  return new Date(unix).toLocaleString()
}

switch (command) {
  case 'create': {
    const prompt = args[1]
    const cron = args[2]
    const chatId = args[3]

    if (!prompt || !cron || !chatId) {
      console.error('Error: create requires <prompt> <cron> <chat_id>')
      usage()
      process.exit(1)
    }

    // Validate cron expression
    try {
      cronParser.parseExpression(cron)
    } catch {
      console.error(`Error: invalid cron expression "${cron}"`)
      process.exit(1)
    }

    const id = args[4] || slugify(prompt)
    const nextRun = computeNextRun(cron)

    // Check for duplicate ID
    const existing = getTask(id)
    if (existing) {
      console.error(`Error: task with id "${id}" already exists. Pass a unique id as the 5th argument.`)
      process.exit(1)
    }

    const projectId = args[5] || 'default'
    createTask(id, chatId, prompt, cron, nextRun, projectId)

    console.log(`Created task: ${id}`)
    console.log(`  Prompt:   ${prompt}`)
    console.log(`  Schedule: ${cron}`)
    console.log(`  Chat ID:  ${chatId}`)
    console.log(`  Project:  ${projectId}`)
    console.log(`  Next run: ${formatTimestamp(nextRun)}`)
    break
  }

  case 'list': {
    const tasks = listTasks()

    if (tasks.length === 0) {
      console.log('No scheduled tasks.')
      break
    }

    console.log(
      'ID'.padEnd(10) +
        'Status'.padEnd(9) +
        'Schedule'.padEnd(18) +
        'Next Run'.padEnd(22) +
        'Prompt',
    )
    console.log('-'.repeat(90))

    for (const t of tasks) {
      console.log(
        String(t.id).padEnd(10) +
          String(t.status).padEnd(9) +
          String(t.schedule).padEnd(18) +
          formatTimestamp(t.next_run).padEnd(22) +
          t.prompt.slice(0, 40),
      )
    }
    break
  }

  case 'delete': {
    const id = args[1]
    if (!id) {
      console.error('Error: delete requires <id>')
      process.exit(1)
    }
    const deleted = deleteTask(id)
    if (deleted) {
      console.log(`Deleted task: ${id}`)
    } else {
      console.error(`Task not found: ${id}`)
      process.exit(1)
    }
    break
  }

  case 'pause': {
    const id = args[1]
    if (!id) {
      console.error('Error: pause requires <id>')
      process.exit(1)
    }
    const task = getTask(id)
    if (!task) {
      console.error(`Task not found: ${id}`)
      process.exit(1)
    }
    pauseTask(id)
    console.log(`Paused task: ${id}`)
    break
  }

  case 'resume': {
    const id = args[1]
    if (!id) {
      console.error('Error: resume requires <id>')
      process.exit(1)
    }

    const task = getTask(id)
    if (!task) {
      console.error(`Task not found: ${id}`)
      process.exit(1)
    }

    const nextRun = computeNextRun(task.schedule)
    resumeTask(id, nextRun)
    console.log(`Resumed task: ${id}`)
    console.log(`  Next run: ${formatTimestamp(nextRun)}`)
    break
  }

  default:
    if (command) {
      console.error(`Unknown command: ${command}`)
    }
    usage()
    process.exit(command ? 1 : 0)
}
