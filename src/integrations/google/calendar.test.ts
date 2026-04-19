import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEventsList = vi.fn()
const mockEventsInsert = vi.fn()
const mockEventsPatch = vi.fn()
const mockEventsDelete = vi.fn()
const mockCalendarListList = vi.fn()

vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => ({
      events: {
        list: mockEventsList,
        insert: mockEventsInsert,
        patch: mockEventsPatch,
        delete: mockEventsDelete,
      },
      calendarList: {
        list: mockCalendarListList,
      },
    })),
    auth: {
      OAuth2: class {
        setCredentials() {}
        credentials = {}
      },
    },
  },
}))

import { CalendarModule } from './calendar.js'
import { GoogleApiError } from '../errors.js'

const fakeAuth = {} as never

function makeRawEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-123',
    summary: 'Team Meeting',
    description: 'Weekly sync',
    location: 'Conference Room A',
    start: { dateTime: '2026-04-07T10:00:00Z' },
    end: { dateTime: '2026-04-07T11:00:00Z' },
    attendees: [
      { email: 'alice@example.com', responseStatus: 'accepted' },
      { email: 'bob@example.com', responseStatus: 'needsAction' },
    ],
    ...overrides,
  }
}

function makeExpectedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-123',
    summary: 'Team Meeting',
    description: 'Weekly sync',
    location: 'Conference Room A',
    start: '2026-04-07T10:00:00Z',
    end: '2026-04-07T11:00:00Z',
    attendees: [
      { email: 'alice@example.com', responseStatus: 'accepted' },
      { email: 'bob@example.com', responseStatus: 'needsAction' },
    ],
    ...overrides,
  }
}

describe('CalendarModule', () => {
  let cal: CalendarModule

  beforeEach(() => {
    cal = new CalendarModule()
    vi.clearAllMocks()
  })

  describe('list', () => {
    it('returns CalendarEvent array', async () => {
      const raw = makeRawEvent()
      mockEventsList.mockResolvedValue({ data: { items: [raw] } })

      const results = await cal.list(fakeAuth, 'primary', '2026-04-01T00:00:00Z', '2026-04-30T23:59:59Z')

      expect(results).toHaveLength(1)
      expect(results[0]).toEqual(makeExpectedEvent())

      const call = mockEventsList.mock.calls[0][0]
      expect(call.calendarId).toBe('primary')
      expect(call.singleEvents).toBe(true)
      expect(call.orderBy).toBe('startTime')
    })

    it('appends T00:00:00Z to date-only timeMin', async () => {
      mockEventsList.mockResolvedValue({ data: { items: [] } })

      await cal.list(fakeAuth, 'primary', '2026-04-01', '2026-04-30T23:59:59Z')

      const call = mockEventsList.mock.calls[0][0]
      expect(call.timeMin).toBe('2026-04-01T00:00:00Z')
    })

    it('appends T23:59:59Z to date-only timeMax', async () => {
      mockEventsList.mockResolvedValue({ data: { items: [] } })

      await cal.list(fakeAuth, 'primary', '2026-04-01T00:00:00Z', '2026-04-30')

      const call = mockEventsList.mock.calls[0][0]
      expect(call.timeMax).toBe('2026-04-30T23:59:59Z')
    })

    it('does not modify timeMin/timeMax that already contain T', async () => {
      mockEventsList.mockResolvedValue({ data: { items: [] } })

      await cal.list(fakeAuth, 'primary', '2026-04-01T00:00:00Z', '2026-04-30T23:59:59Z')

      const call = mockEventsList.mock.calls[0][0]
      expect(call.timeMin).toBe('2026-04-01T00:00:00Z')
      expect(call.timeMax).toBe('2026-04-30T23:59:59Z')
    })

    it('returns empty array when no items', async () => {
      mockEventsList.mockResolvedValue({ data: { items: [] } })

      const results = await cal.list(fakeAuth, 'primary', '2026-04-01', '2026-04-30')
      expect(results).toEqual([])
    })

    it('handles events with date (all-day) instead of dateTime', async () => {
      mockEventsList.mockResolvedValue({
        data: {
          items: [{
            id: 'allday-1',
            summary: 'Holiday',
            start: { date: '2026-04-07' },
            end: { date: '2026-04-08' },
          }],
        },
      })

      const results = await cal.list(fakeAuth, 'primary', '2026-04-01', '2026-04-30')
      expect(results[0].start).toBe('2026-04-07')
      expect(results[0].end).toBe('2026-04-08')
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockEventsList.mockRejectedValue({ code: 403, message: 'Forbidden' })

      await expect(cal.list(fakeAuth, 'primary', '2026-04-01', '2026-04-30')).rejects.toThrow(GoogleApiError)
    })
  })

  describe('create', () => {
    it('returns new CalendarEvent with correct shape', async () => {
      const raw = makeRawEvent()
      mockEventsInsert.mockResolvedValue({ data: raw })

      const input = {
        summary: 'Team Meeting',
        description: 'Weekly sync',
        location: 'Conference Room A',
        start: '2026-04-07T10:00:00Z',
        end: '2026-04-07T11:00:00Z',
        attendees: ['alice@example.com', 'bob@example.com'],
      }

      const result = await cal.create(fakeAuth, 'primary', input)

      expect(result).toEqual(makeExpectedEvent())

      const call = mockEventsInsert.mock.calls[0][0]
      expect(call.calendarId).toBe('primary')
      expect(call.requestBody.summary).toBe('Team Meeting')
      expect(call.requestBody.start).toEqual({ dateTime: '2026-04-07T10:00:00Z' })
      expect(call.requestBody.end).toEqual({ dateTime: '2026-04-07T11:00:00Z' })
      expect(call.requestBody.attendees).toEqual([
        { email: 'alice@example.com' },
        { email: 'bob@example.com' },
      ])
    })

    it('creates event without attendees', async () => {
      const raw = makeRawEvent({ attendees: null })
      mockEventsInsert.mockResolvedValue({ data: raw })

      const input = {
        summary: 'Solo Task',
        start: '2026-04-07T10:00:00Z',
        end: '2026-04-07T11:00:00Z',
      }

      await cal.create(fakeAuth, 'primary', input)

      const call = mockEventsInsert.mock.calls[0][0]
      expect(call.requestBody.attendees).toBeUndefined()
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockEventsInsert.mockRejectedValue({ code: 400, message: 'Bad Request' })

      await expect(cal.create(fakeAuth, 'primary', {
        summary: 'Test',
        start: '2026-04-07T10:00:00Z',
        end: '2026-04-07T11:00:00Z',
      })).rejects.toThrow(GoogleApiError)
    })
  })

  describe('update', () => {
    it('only sends non-undefined fields in patch', async () => {
      const raw = makeRawEvent({ summary: 'Updated Meeting' })
      mockEventsPatch.mockResolvedValue({ data: raw })

      const result = await cal.update(fakeAuth, 'primary', 'event-123', { summary: 'Updated Meeting' })

      expect(result.summary).toBe('Updated Meeting')

      const call = mockEventsPatch.mock.calls[0][0]
      expect(call.calendarId).toBe('primary')
      expect(call.eventId).toBe('event-123')
      expect(call.requestBody.summary).toBe('Updated Meeting')
      expect(call.requestBody).not.toHaveProperty('description')
      expect(call.requestBody).not.toHaveProperty('location')
    })

    it('converts attendees string[] to {email}[] in patch', async () => {
      const raw = makeRawEvent()
      mockEventsPatch.mockResolvedValue({ data: raw })

      await cal.update(fakeAuth, 'primary', 'event-123', {
        attendees: ['carol@example.com'],
      })

      const call = mockEventsPatch.mock.calls[0][0]
      expect(call.requestBody.attendees).toEqual([{ email: 'carol@example.com' }])
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockEventsPatch.mockRejectedValue({ code: 404, message: 'Not Found' })

      await expect(cal.update(fakeAuth, 'primary', 'bad-id', { summary: 'x' })).rejects.toThrow(GoogleApiError)
    })
  })

  describe('delete', () => {
    it('calls events.delete with correct params', async () => {
      mockEventsDelete.mockResolvedValue({})

      await expect(cal.delete(fakeAuth, 'primary', 'event-123')).resolves.toBeUndefined()

      const call = mockEventsDelete.mock.calls[0][0]
      expect(call.calendarId).toBe('primary')
      expect(call.eventId).toBe('event-123')
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockEventsDelete.mockRejectedValue({ code: 404, message: 'Not Found' })

      await expect(cal.delete(fakeAuth, 'primary', 'bad-id')).rejects.toThrow(GoogleApiError)
    })
  })

  describe('listCalendars', () => {
    it('returns CalendarInfo array', async () => {
      mockCalendarListList.mockResolvedValue({
        data: {
          items: [
            { id: 'primary', summary: 'Test User', primary: true, timeZone: 'America/New_York' },
            { id: 'work@example.com', summary: 'Work', primary: false, timeZone: 'America/Chicago' },
          ],
        },
      })

      const results = await cal.listCalendars(fakeAuth)

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        id: 'primary',
        summary: 'Test User',
        primary: true,
        timeZone: 'America/New_York',
      })
      expect(results[1]).toEqual({
        id: 'work@example.com',
        summary: 'Work',
        primary: false,
        timeZone: 'America/Chicago',
      })
    })

    it('returns empty array when no calendars', async () => {
      mockCalendarListList.mockResolvedValue({ data: { items: [] } })

      const results = await cal.listCalendars(fakeAuth)
      expect(results).toEqual([])
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockCalendarListList.mockRejectedValue({ code: 401, message: 'Unauthorized' })

      await expect(cal.listCalendars(fakeAuth)).rejects.toThrow(GoogleApiError)
      await expect(cal.listCalendars(fakeAuth)).rejects.toThrow('401')
    })
  })
})
