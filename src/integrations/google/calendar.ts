import { google } from 'googleapis'
import { GoogleApiError } from '../errors.js'
import type { CalendarEvent, CalendarEventInput, CalendarInfo } from '../types.js'

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>

function wrapError(err: unknown, method: string): never {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: number; message: string }
    throw new GoogleApiError(e.code, e.message, method)
  }
  throw new GoogleApiError(500, String(err), method)
}

function toISODateTime(dt: string, suffix: string): string {
  return dt.includes('T') ? dt : `${dt}${suffix}`
}

function toEvent(e: {
  id?: string | null
  summary?: string | null
  description?: string | null
  location?: string | null
  start?: { dateTime?: string | null; date?: string | null } | null
  end?: { dateTime?: string | null; date?: string | null } | null
  attendees?: Array<{ email?: string | null; responseStatus?: string | null }> | null
}): CalendarEvent {
  return {
    id: e.id ?? '',
    summary: e.summary ?? '',
    description: e.description ?? undefined,
    location: e.location ?? undefined,
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    attendees: e.attendees
      ? e.attendees.map(a => ({
          email: a.email ?? '',
          responseStatus: a.responseStatus ?? '',
        }))
      : undefined,
  }
}

export class CalendarModule {
  async list(
    auth: OAuth2Client,
    calendarId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<CalendarEvent[]> {
    const calendar = google.calendar({ version: 'v3', auth })
    try {
      const res = await calendar.events.list({
        calendarId,
        timeMin: toISODateTime(timeMin, 'T00:00:00Z'),
        timeMax: toISODateTime(timeMax, 'T23:59:59Z'),
        singleEvents: true,
        orderBy: 'startTime',
      })
      return (res.data.items ?? []).map(toEvent)
    } catch (err) {
      wrapError(err, 'calendar.list')
    }
  }

  async create(
    auth: OAuth2Client,
    calendarId: string,
    event: CalendarEventInput,
  ): Promise<CalendarEvent> {
    const calendar = google.calendar({ version: 'v3', auth })
    try {
      const res = await calendar.events.insert({
        calendarId,
        requestBody: {
          summary: event.summary,
          description: event.description,
          location: event.location,
          start: { dateTime: event.start },
          end: { dateTime: event.end },
          attendees: event.attendees?.map(email => ({ email })),
        },
      })
      return toEvent(res.data)
    } catch (err) {
      wrapError(err, 'calendar.create')
    }
  }

  async update(
    auth: OAuth2Client,
    calendarId: string,
    eventId: string,
    updates: Partial<CalendarEventInput>,
  ): Promise<CalendarEvent> {
    const calendar = google.calendar({ version: 'v3', auth })
    try {
      const patch: Record<string, unknown> = {}
      if (updates.summary !== undefined) patch.summary = updates.summary
      if (updates.description !== undefined) patch.description = updates.description
      if (updates.location !== undefined) patch.location = updates.location
      if (updates.start !== undefined) patch.start = { dateTime: updates.start }
      if (updates.end !== undefined) patch.end = { dateTime: updates.end }
      if (updates.attendees !== undefined) patch.attendees = updates.attendees.map(email => ({ email }))

      const res = await calendar.events.patch({
        calendarId,
        eventId,
        requestBody: patch,
      })
      return toEvent(res.data)
    } catch (err) {
      wrapError(err, 'calendar.update')
    }
  }

  async delete(auth: OAuth2Client, calendarId: string, eventId: string): Promise<void> {
    const calendar = google.calendar({ version: 'v3', auth })
    try {
      await calendar.events.delete({ calendarId, eventId })
    } catch (err) {
      wrapError(err, 'calendar.delete')
    }
  }

  async listCalendars(auth: OAuth2Client): Promise<CalendarInfo[]> {
    const calendar = google.calendar({ version: 'v3', auth })
    try {
      const res = await calendar.calendarList.list()
      return (res.data.items ?? []).map(c => ({
        id: c.id ?? '',
        summary: c.summary ?? '',
        primary: c.primary ?? false,
        timeZone: c.timeZone ?? '',
      }))
    } catch (err) {
      wrapError(err, 'calendar.listCalendars')
    }
  }
}
