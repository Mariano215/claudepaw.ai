import { initDatabase } from '../db.js'
import { initCredentialStore, getCredential } from '../credentials.js'
import { CREDENTIAL_ENCRYPTION_KEY } from '../config.js'
import { readEnvFile } from '../env.js'
import { IntegrationEngine } from './engine.js'
import { googleManifest } from './google/manifest.js'
import { GoogleClient } from './google/client.js'
import { GmailModule } from './google/gmail.js'
import { DriveModule } from './google/drive.js'
import { SheetsModule } from './google/sheets.js'
import { CalendarModule } from './google/calendar.js'
import { ImapModule } from './imap/client.js'
import type { ImapConfig } from './imap/types.js'

export interface ParsedArgs {
  service: string
  module: string
  command: string
  project: string
  account?: string
  options: Record<string, string>
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Expected: service google <module> <command> [--project <id>] [--account <email>] [--key value ...]
  // argv[0] = 'service' (literal), argv[1] = service name (e.g. 'google'), argv[2] = module, argv[3] = command
  // For flat services like 'imap', command may be omitted: service imap <command> --project ...
  const [, service, module, maybeCommand, ...rest] = argv

  if (!service || !module) {
    throw new Error('Missing required argument: module')
  }

  // If maybeCommand starts with '--' it's a flag, not a command (flat service like imap)
  let command: string
  let flagArgs: string[]
  if (!maybeCommand || maybeCommand.startsWith('--')) {
    command = ''
    flagArgs = maybeCommand ? [maybeCommand, ...rest] : rest
  } else {
    command = maybeCommand
    flagArgs = rest
  }

  // For Google-style services, command is required
  if (!command && service !== 'imap') {
    throw new Error('Missing required argument: command')
  }

  // Parse flags
  const flags: Record<string, string> = {}
  for (let i = 0; i < flagArgs.length; i++) {
    const arg = flagArgs[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const val = flagArgs[i + 1]
      if (val !== undefined && !val.startsWith('--')) {
        flags[key] = val
        i++
      } else {
        flags[key] = 'true'
      }
    }
  }

  if (!flags.project) {
    throw new Error('Missing required flag: --project')
  }

  const { project, account, ...options } = flags

  return {
    service,
    module,
    command,
    project,
    account,
    options,
  }
}

/**
 * Read IMAP credentials from the credential store.
 * Keys are stored as: (projectId, 'imap:<email>', 'host'|'port'|'password'|'tls')
 */
export function resolveImapConfig(projectId: string, account: string): ImapConfig {
  const svc = `imap:${account}`
  const host = getCredential(projectId, svc, 'host')
  const portStr = getCredential(projectId, svc, 'port')
  const password = getCredential(projectId, svc, 'password')
  const tlsStr = getCredential(projectId, svc, 'tls')

  if (!host) throw new Error(`IMAP host not configured for ${account} in project ${projectId}`)
  if (!password) throw new Error(`IMAP password not configured for ${account} in project ${projectId}`)

  return {
    host,
    port: portStr ? Number(portStr) : 993,
    email: account,
    password,
    tls: tlsStr !== 'false',  // default true
  }
}

export async function run(): Promise<void> {
  const argv = process.argv.slice(2)
  const env = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])

  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  }

  const clientId = process.env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? ''

  let result: unknown

  try {
    const db = initDatabase()
    initCredentialStore(db)

    const { service, module, command, options } = args

    // --- IMAP service (no OAuth, credentials from credential store) ---
    if (service === 'imap') {
      if (!args.account) {
        throw new Error('Missing required flag: --account (IMAP email address)')
      }
      const imapConfig = resolveImapConfig(args.project, args.account)
      const imap = new ImapModule()
      // For imap, 'module' holds the command (search, read, folders)
      const imapCommand = module
      switch (imapCommand) {
        case 'search':
          result = await imap.search(imapConfig, {
            folder: options.folder,
            query: options.query,
            max: options.max ? Number(options.max) : undefined,
          })
          break
        case 'read':
          if (!options.uid) throw new Error('Missing required option: --uid')
          result = await imap.read(imapConfig, Number(options.uid), options.folder)
          break
        case 'folders':
          result = await imap.listFolders(imapConfig)
          break
        default:
          throw new Error(`Unknown imap command: ${imapCommand}. Use: search, read, folders`)
      }
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      return
    }

    // --- Google service ---
    const engine = new IntegrationEngine(CREDENTIAL_ENCRYPTION_KEY)
    engine.register(googleManifest)

    const googleClient = new GoogleClient(engine, clientId, clientSecret)
    const auth = await googleClient.ensureFreshToken(args.project, args.account)

    switch (module) {
      case 'gmail': {
        const gmail = new GmailModule()
        switch (command) {
          case 'search':
            result = await gmail.search(auth, options.query ?? '', {
              maxResults: options.max ? Number(options.max) : undefined,
              pageToken: options.pageToken,
            })
            break
          case 'read':
            result = await gmail.read(auth, options.id)
            break
          case 'read-thread':
            result = await gmail.readThread(auth, options.id)
            break
          case 'create-draft':
            result = await gmail.createDraft(auth, {
              to: options.to,
              cc: options.cc,
              bcc: options.bcc,
              subject: options.subject,
              body: options.body,
              replyTo: options.replyTo,
            })
            break
          case 'send-draft':
            await gmail.sendDraft(auth, options.id)
            result = { ok: true }
            break
          case 'labels':
            result = await gmail.listLabels(auth)
            break
          case 'drafts':
            result = await gmail.listDrafts(auth)
            break
          default:
            throw new Error(`Unknown gmail command: ${command}`)
        }
        break
      }

      case 'drive': {
        const drive = new DriveModule()
        switch (command) {
          case 'list':
            result = await drive.list(auth, {
              parentId: options.parentId,
              maxResults: options.max ? Number(options.max) : undefined,
              mimeType: options.mimeType,
            })
            break
          case 'search':
            result = await drive.search(auth, options.query)
            break
          case 'download':
            await drive.download(auth, options.id, options.dest)
            result = { ok: true }
            break
          case 'upload':
            result = await drive.upload(auth, options.file, {
              parentId: options.parentId,
              name: options.name,
              mimeType: options.mimeType,
            })
            break
          case 'mkdir':
            result = await drive.mkdir(auth, options.name, options.parentId)
            break
          case 'delete':
            await drive.delete(auth, options.id)
            result = { ok: true }
            break
          case 'metadata':
            result = await drive.getMetadata(auth, options.id)
            break
          default:
            throw new Error(`Unknown drive command: ${command}`)
        }
        break
      }

      case 'sheets': {
        const sheets = new SheetsModule()
        switch (command) {
          case 'read':
            result = await sheets.read(auth, options.sheet, options.range)
            break
          case 'write': {
            const values = JSON.parse(options.values) as string[][]
            await sheets.write(auth, options.sheet, options.range, values)
            result = { ok: true }
            break
          }
          case 'append': {
            const values = JSON.parse(options.values) as string[][]
            await sheets.append(auth, options.sheet, options.range, values)
            result = { ok: true }
            break
          }
          case 'metadata':
            result = await sheets.metadata(auth, options.sheet)
            break
          default:
            throw new Error(`Unknown sheets command: ${command}`)
        }
        break
      }

      case 'calendar': {
        const calendar = new CalendarModule()
        switch (command) {
          case 'list':
            result = await calendar.list(
              auth,
              options.calendarId ?? 'primary',
              options.timeMin,
              options.timeMax,
            )
            break
          case 'create': {
            const attendees = options.attendees ? options.attendees.split(',') : undefined
            result = await calendar.create(auth, options.calendarId ?? 'primary', {
              summary: options.summary,
              description: options.description,
              location: options.location,
              start: options.start,
              end: options.end,
              attendees,
            })
            break
          }
          case 'update': {
            const attendees = options.attendees ? options.attendees.split(',') : undefined
            result = await calendar.update(auth, options.calendarId ?? 'primary', options.id, {
              summary: options.summary,
              description: options.description,
              location: options.location,
              start: options.start,
              end: options.end,
              attendees,
            })
            break
          }
          case 'delete':
            await calendar.delete(auth, options.calendarId ?? 'primary', options.id)
            result = { ok: true }
            break
          case 'calendars':
            result = await calendar.listCalendars(auth)
            break
          default:
            throw new Error(`Unknown calendar command: ${command}`)
        }
        break
      }

      default:
        throw new Error(`Unknown module: ${module}`)
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  }
}

if (process.argv[1]?.includes('cli')) {
  run().catch((err) => {
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  })
}
