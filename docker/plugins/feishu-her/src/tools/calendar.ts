/**
 * Feishu Calendar tool — list/get/create/update/delete calendar events.
 * Uses calendar v4 API with user_access_token (OAuth) for full event details.
 * Falls back to tenant_access_token for check_freebusy (no user auth needed).
 * Ref: https://open.feishu.cn/document/server-docs/calendar-v4/overview
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { getFeishuClient } from "../outbound.js";
import { buildSendDirectToUser, getOAuthDirectSender } from "./oauth-direct.js";
import { toUnixSecondsStr, toRfc3339 } from "./time-utils.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Helpers ──

// Time conversion: use shared time-utils (toUnixSecondsStr, toRfc3339)
const toTimestamp = toUnixSecondsStr;

/** Convert a Feishu calendar timestamp to human-readable ISO 8601. */
function humanizeTimestamp(t: { timestamp?: string; timezone?: string } | undefined) {
  if (!t?.timestamp) {return t;}
  return { ...t, datetime: new Date(Number(t.timestamp) * 1000).toISOString() };
}

/** Extract useful fields from a raw calendar event. */
// oxlint-disable-next-line typescript/no-explicit-any
function formatEvent(e: any) {
  return {
    event_id: e.event_id,
    summary: e.summary,
    description: e.description,
    start_time: humanizeTimestamp(e.start_time),
    end_time: humanizeTimestamp(e.end_time),
    status: e.status,
    location: e.location,
    organizer: e.event_organizer,
    attendees: e.attendees,
    visibility: e.visibility,
    free_busy_status: e.free_busy_status,
    recurrence: e.recurrence,
    reminders: e.reminders,
    app_link: e.app_link,
    vchat: e.vchat,
    meeting_rooms: e.meeting_rooms,
  };
}

// ── User-token calendar API calls ──

async function listCalendarsUser(userToken: string, pageSize?: number, pageToken?: string) {
  const query: Record<string, string> = { page_size: String(pageSize ?? 500) };
  if (pageToken) {query.page_token = pageToken;}
  const res = await callFeishuApiWithUserToken<{
    calendar_list?: {
      calendar_id: string;
      summary: string;
      description: string;
      type: string;
      role: string;
      permissions: string;
    }[];
    has_more?: boolean;
    page_token?: string;
  }>({ method: "GET", endpoint: "/calendar/v4/calendars", userToken, query });
  if (res.code !== 0) {throw new Error(res.msg);}
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    calendars: (res.data?.calendar_list ?? []).map((c: any) => ({
      calendar_id: c.calendar_id,
      summary: c.summary,
      description: c.description,
      type: c.type,
      role: c.role,
      permissions: c.permissions,
    })),
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
  };
}

async function getPrimaryCalendarUser(userToken: string) {
  // Use list_calendars + filter for role=owner instead of /calendars/primary,
  // because the /primary endpoint may route as /:calendar_id with user tokens.
  const all = await listCalendarsUser(userToken);
  const primary = all.calendars.filter((c) => c.role === "owner");
  return { calendars: primary };
}

async function searchCalendarsUser(userToken: string, query: string, pageSize?: number) {
  const res = await callFeishuApiWithUserToken<{
    items?: {
      calendar_id: string;
      summary: string;
      description: string;
      type: string;
      role: string;
      permissions: string;
    }[];
  }>({
    method: "POST",
    endpoint: "/calendar/v4/calendars/search",
    userToken,
    body: { query },
    query: { page_size: String(pageSize ?? 50) },
  });
  if (res.code !== 0) {throw new Error(res.msg);}
  // oxlint-disable-next-line typescript/no-explicit-any
  return {
    calendars: (res.data?.items ?? []).map((c: any) => ({
      calendar_id: c.calendar_id,
      summary: c.summary,
      description: c.description,
      type: c.type,
      role: c.role,
      permissions: c.permissions,
    })),
  };
}

async function subscribeCalendarUser(userToken: string, calendarId: string) {
  const res = await callFeishuApiWithUserToken<{
    calendar?: { calendar_id: string; summary: string; type: string; role: string };
  }>({ method: "POST", endpoint: `/calendar/v4/calendars/${calendarId}/subscribe`, userToken });
  if (res.code !== 0) {throw new Error(res.msg);}
  const cal = res.data?.calendar;
  return {
    subscribed: true,
    calendar_id: cal?.calendar_id,
    summary: cal?.summary,
    type: cal?.type,
    role: cal?.role,
  };
}

async function listEventsUser(
  userToken: string,
  calendarId: string,
  startTime?: string,
  endTime?: string,
  pageSize?: number,
  pageToken?: string,
) {
  const query: Record<string, string> = { page_size: String(Math.max(pageSize ?? 50, 50)) };
  if (startTime) {query.start_time = toTimestamp(startTime);}
  if (endTime) {query.end_time = toTimestamp(endTime);}
  if (pageToken) {query.page_token = pageToken;}
  const res = await callFeishuApiWithUserToken<{
    items?: unknown[];
    has_more?: boolean;
    page_token?: string;
  }>({ method: "GET", endpoint: `/calendar/v4/calendars/${calendarId}/events`, userToken, query });
  if (res.code !== 0) {throw new Error(res.msg);}
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    events: (res.data?.items ?? []).map((e: any) => formatEvent(e)),
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
  };
}

async function getEventUser(userToken: string, calendarId: string, eventId: string) {
  const res = await callFeishuApiWithUserToken<{ event?: unknown }>({
    method: "GET",
    endpoint: `/calendar/v4/calendars/${calendarId}/events/${eventId}`,
    userToken,
    query: { need_attendee: "true", user_id_type: "open_id" },
  });
  if (res.code !== 0) {throw new Error(res.msg);}
  return { event: formatEvent(res.data?.event ?? {}) };
}

async function createEventUser(
  userToken: string,
  calendarId: string,
  summary: string,
  startTime: string,
  endTime: string,
  description?: string,
  location?: string,
  attendeeIds?: string[],
  roomIds?: string[],
  timezone?: string,
) {
  const tz = timezone ?? "Asia/Shanghai";
  // oxlint-disable-next-line typescript/no-explicit-any
  const data: any = {
    summary,
    start_time: { timestamp: toTimestamp(startTime), timezone: tz },
    end_time: { timestamp: toTimestamp(endTime), timezone: tz },
    attendee_ability: "can_see_others",
    need_notification: true,
    ...(description && { description }),
    ...(location && { location: { name: location } }),
  };
  const res = await callFeishuApiWithUserToken<{ event?: unknown }>({
    method: "POST",
    endpoint: `/calendar/v4/calendars/${calendarId}/events`,
    userToken,
    body: data,
    query: { user_id_type: "open_id" },
  });
  if (res.code !== 0) {throw new Error(res.msg);}
  // oxlint-disable-next-line typescript/no-explicit-any
  const event = res.data?.event as any;

  if ((attendeeIds?.length || roomIds?.length) && event?.event_id) {
    await addAttendeesUser(userToken, calendarId, event.event_id, attendeeIds ?? [], roomIds);
  }

  return { event: formatEvent(event ?? {}) };
}

async function addAttendeesUser(
  userToken: string,
  calendarId: string,
  eventId: string,
  attendeeIds: string[],
  roomIds?: string[],
) {
  const attendees: { type: string; user_id?: string; room_id?: string }[] = attendeeIds.map(
    (id) => ({ type: "user", user_id: id }),
  );
  if (roomIds) {
    for (const rid of roomIds) {
      attendees.push({ type: "resource", room_id: rid });
    }
  }
  const res = await callFeishuApiWithUserToken({
    method: "POST",
    endpoint: `/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees`,
    userToken,
    body: { attendees, need_notification: true },
    query: { user_id_type: "open_id" },
  });
  if (res.code !== 0) {throw new Error(res.msg);}
  return res.data;
}

/** List enterprise meeting rooms via tenant token. */
async function listRooms(
  client: Lark.Client,
  pageSize?: number,
  pageToken?: string,
): Promise<unknown> {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.vc.room.list({
    params: { page_size: pageSize ?? 50, ...(pageToken ? { page_token: pageToken } : {}) },
  });
  if (res.code !== 0) {throw new Error(res.msg ?? `vc.room.list failed: ${res.code}`);}
  const allRooms = (res.data?.rooms ?? []).map((r: any) => ({
    room_id: r.room_id,
    name: r.name,
    capacity: r.capacity,
    description: r.description,
    enabled: r.room_status?.status !== false,
  }));
  // Filter out disabled rooms (status=false means permanently disabled)
  const activeRooms = allRooms.filter((r: any) => r.enabled);
  return { rooms: activeRooms, has_more: res.data?.has_more, page_token: res.data?.page_token };
}

/** Check meeting room free/busy via tenant token. */
async function checkRoomFreebusy(
  client: Lark.Client,
  roomId: string,
  startTime: string,
  endTime: string,
): Promise<unknown> {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.calendar.freebusy.list({
    data: { time_min: startTime, time_max: endTime, room_id: roomId },
  });
  if (res.code !== 0) {throw new Error(res.msg ?? `freebusy.list failed: ${res.code}`);}
  const busy = res.data?.freebusy_list ?? [];
  return { room_id: roomId, is_free: busy.length === 0, busy_slots: busy };
}

async function removeAttendeesUser(
  userToken: string,
  calendarId: string,
  eventId: string,
  attendeeIds: string[],
) {
  // List current attendees to find their attendee_ids by open_id
  const listRes = await callFeishuApiWithUserToken<{
    items?: { attendee_id: string; user_id?: string }[];
  }>({
    method: "GET",
    endpoint: `/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees`,
    userToken,
    query: { user_id_type: "open_id", page_size: "50" },
  });
  if (listRes.code !== 0) {throw new Error(listRes.msg);}

  const items = listRes.data?.items ?? [];
  const toRemove = items
    .filter((a) => attendeeIds.includes(a.user_id ?? ""))
    .map((a) => a.attendee_id);
  if (toRemove.length === 0) {
    return { removed: 0, message: "No matching attendees found to remove" };
  }

  const res = await callFeishuApiWithUserToken({
    method: "POST",
    endpoint: `/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees/batch_delete`,
    userToken,
    body: { attendee_ids: toRemove, need_notification: true },
  });
  if (res.code !== 0) {throw new Error(res.msg);}
  return { removed: toRemove.length };
}

async function updateEventUser(
  userToken: string,
  calendarId: string,
  eventId: string,
  summary?: string,
  startTime?: string,
  endTime?: string,
  description?: string,
  location?: string,
  timezone?: string,
  attendeeIds?: string[],
  roomIds?: string[],
) {
  const tz = timezone ?? "Asia/Shanghai";
  // oxlint-disable-next-line typescript/no-explicit-any
  const data: any = {};
  if (summary !== undefined) {data.summary = summary;}
  if (description !== undefined) {data.description = description;}
  if (startTime) {data.start_time = { timestamp: toTimestamp(startTime), timezone: tz };}
  if (endTime) {data.end_time = { timestamp: toTimestamp(endTime), timezone: tz };}
  if (location) {data.location = { name: location };}

  if (Object.keys(data).length > 0) {
    const res = await callFeishuApiWithUserToken({
      method: "PATCH",
      endpoint: `/calendar/v4/calendars/${calendarId}/events/${eventId}`,
      userToken,
      body: data,
      query: { user_id_type: "open_id" },
    });
    if (res.code !== 0) {throw new Error(res.msg);}
  }

  if (attendeeIds?.length || roomIds?.length) {
    await addAttendeesUser(userToken, calendarId, eventId, attendeeIds ?? [], roomIds);
  }

  // Verify
  return getEventUser(userToken, calendarId, eventId);
}

async function deleteEventUser(userToken: string, calendarId: string, eventId: string) {
  const res = await callFeishuApiWithUserToken({
    method: "DELETE",
    endpoint: `/calendar/v4/calendars/${calendarId}/events/${eventId}`,
    userToken,
    query: { need_notification: "true" },
  });
  if (res.code !== 0) {throw new Error(res.msg);}
  return { deleted: true, event_id: eventId };
}

// ── Freebusy uses tenant token (no user auth needed) ──

async function checkFreebusy(
  client: Lark.Client,
  userOpenId: string,
  startTime: string,
  endTime: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await (client.calendar as any).freebusy.list({
    data: {
      time_min: toRfc3339(startTime),
      time_max: toRfc3339(endTime),
      user_id: userOpenId,
    },
    params: { user_id_type: "open_id" },
  });
  if (res.code !== 0) {throw new Error(res.msg);}
  return {
    user_open_id: userOpenId,
    freebusy_list: res.data?.freebusy_list ?? [],
  };
}

// ── Schema ──

const CALENDAR_ACTIONS = [
  "get_primary",
  "list_calendars",
  "search_calendars",
  "subscribe_calendar",
  "list_events",
  "get_event",
  "create_event",
  "update_event",
  "delete_event",
  "remove_attendees",
  "check_freebusy",
  "list_rooms",
  "check_room_freebusy",
] as const;

const FeishuCalendarSchema = Type.Object({
  action: stringEnum(CALENDAR_ACTIONS, {
    description:
      "Calendar operation: get_primary (get user's own primary calendar), " +
      "list_calendars (list ALL calendars the user can access, including shared ones), " +
      "search_calendars (search public calendars or user primary calendars by keyword), " +
      "subscribe_calendar (subscribe to a public/shared calendar to access its events), " +
      "list_events (list events with optional time range), " +
      "get_event (single event detail), " +
      "create_event (create new event), " +
      "update_event (modify existing event fields and/or add attendees), " +
      "delete_event (remove event), " +
      "remove_attendees (remove specific attendees from event by open_id), " +
      "check_freebusy (check any user's busy/free time by open_id — no calendar sharing needed), " +
      "list_rooms (list enterprise meeting rooms — no OAuth needed), " +
      "check_room_freebusy (check meeting room availability by room_id — no OAuth needed)",
  }),
  calendar_id: Type.Optional(
    Type.String({
      description:
        "Calendar ID. Use get_primary or list_calendars to obtain it. Required for all event operations.",
    }),
  ),
  event_id: Type.Optional(
    Type.String({ description: "Event ID, required for get/update/delete_event" }),
  ),
  start_time: Type.Optional(
    Type.String({
      description:
        "ISO 8601 datetime (e.g. 2026-02-25T09:00:00+08:00). " +
        "For list_events: filter start. For create/update_event: event start time.",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description:
        "ISO 8601 datetime. For list_events: filter end. For create/update_event: event end time.",
    }),
  ),
  summary: Type.Optional(Type.String({ description: "Event title (create/update)" })),
  description: Type.Optional(Type.String({ description: "Event description (create/update)" })),
  location: Type.Optional(Type.String({ description: "Event location name (create/update)" })),
  attendee_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Array of attendee open_ids (create_event / update_event / remove_attendees). Use feishu_directory to look up IDs.",
    }),
  ),
  room_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Array of meeting room IDs (omm_xxx) to book when creating/updating events. Use list_rooms to find room IDs.",
    }),
  ),
  room_id: Type.Optional(
    Type.String({
      description: "Single meeting room ID (omm_xxx) for check_room_freebusy.",
    }),
  ),
  user_open_id: Type.Optional(
    Type.String({
      description: "User open_id for check_freebusy. Get from conversation metadata sender_id.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Search keyword for search_calendars (e.g. user name or calendar title)",
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description: "IANA timezone (default: Asia/Shanghai). E.g. Asia/Shanghai, America/New_York",
    }),
  ),
  page_size: Type.Optional(
    Type.Number({ description: "Results per page, minimum 50 (default 50)" }),
  ),
  page_token: Type.Optional(Type.String({ description: "Pagination token for next page" })),
});

// ── Registration ──

export function registerFeishuCalendarTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {return;}
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);
  const redirectUri = resolveOAuthRedirectUri(api.config);

  api.registerTool(
    (toolCtx) => ({
      name: "feishu_calendar",
      label: "Feishu Calendar",
      description:
        "Feishu calendar operations using the user's own identity (OAuth). " +
        "Can read the user's own calendar events, create/update/delete events, manage attendees, " +
        "list and book meeting rooms. " +
        "Use list_rooms to find available rooms, check_room_freebusy to verify availability, " +
        "then pass room_ids to create_event/update_event to book rooms. " +
        "Use check_freebusy to check any user's busy/free time by open_id (no OAuth needed). " +
        "Times use ISO 8601 format with timezone (e.g. 2026-02-25T14:00:00+08:00).",
      parameters: FeishuCalendarSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          // Tenant-token actions (no OAuth needed)
          if (params.action === "list_rooms") {
            const client = getClient();
            return json(await listRooms(client, params.page_size, params.page_token));
          }

          if (params.action === "check_room_freebusy") {
            if (!params.room_id || !params.start_time || !params.end_time)
              {return json({ error: "room_id, start_time, and end_time are required" });}
            const client = getClient();
            return json(
              await checkRoomFreebusy(client, params.room_id, params.start_time, params.end_time),
            );
          }

          if (params.action === "check_freebusy") {
            if (!params.user_open_id || !params.start_time || !params.end_time)
              {return json({ error: "user_open_id, start_time, and end_time are required" });}
            const client = getClient();
            return json(
              await checkFreebusy(client, params.user_open_id, params.start_time, params.end_time),
            );
          }

          // All other actions need user_access_token
          const tokenResult = await requireUserToken({
            account: firstAccount,
            redirectUri,
            tokenPromise: getValidUserToken(firstAccount),
            toolLabel: "日历",
            sendDirectToUser: buildSendDirectToUser(firstAccount, toolCtx.deliveryContext?.to),
          });
          if (!tokenResult.ok) {return tokenResult.authResponse;}
          const userToken = tokenResult.token.access_token;

          switch (params.action) {
            case "get_primary":
              return json(await getPrimaryCalendarUser(userToken));

            case "list_calendars":
              return json(await listCalendarsUser(userToken, params.page_size, params.page_token));

            case "search_calendars": {
              if (!params.query) {return json({ error: "query is required for search_calendars" });}
              return json(await searchCalendarsUser(userToken, params.query, params.page_size));
            }

            case "subscribe_calendar": {
              if (!params.calendar_id)
                {return json({
                  error: "calendar_id is required. Only public/shared calendars can be subscribed.",
                });}
              return json(await subscribeCalendarUser(userToken, params.calendar_id));
            }

            case "list_events": {
              if (!params.calendar_id)
                {return json({ error: "calendar_id is required. Use get_primary first." });}
              return json(
                await listEventsUser(
                  userToken,
                  params.calendar_id,
                  params.start_time,
                  params.end_time,
                  params.page_size,
                  params.page_token,
                ),
              );
            }

            case "get_event": {
              if (!params.calendar_id || !params.event_id)
                {return json({ error: "calendar_id and event_id are required" });}
              return json(await getEventUser(userToken, params.calendar_id, params.event_id));
            }

            case "create_event": {
              if (!params.calendar_id || !params.summary || !params.start_time || !params.end_time)
                {return json({
                  error: "calendar_id, summary, start_time, and end_time are required",
                });}
              return json(
                await createEventUser(
                  userToken,
                  params.calendar_id,
                  params.summary,
                  params.start_time,
                  params.end_time,
                  params.description,
                  params.location,
                  params.attendee_ids,
                  params.room_ids,
                  params.timezone,
                ),
              );
            }

            case "update_event": {
              if (!params.calendar_id || !params.event_id)
                {return json({ error: "calendar_id and event_id are required" });}
              return json(
                await updateEventUser(
                  userToken,
                  params.calendar_id,
                  params.event_id,
                  params.summary,
                  params.start_time,
                  params.end_time,
                  params.description,
                  params.location,
                  params.timezone,
                  params.attendee_ids,
                  params.room_ids,
                ),
              );
            }

            case "delete_event": {
              if (!params.calendar_id || !params.event_id)
                {return json({ error: "calendar_id and event_id are required" });}
              return json(await deleteEventUser(userToken, params.calendar_id, params.event_id));
            }

            case "remove_attendees": {
              if (!params.calendar_id || !params.event_id || !params.attendee_ids?.length)
                {return json({
                  error: "calendar_id, event_id, and attendee_ids are required",
                });}
              return json(
                await removeAttendeesUser(
                  userToken,
                  params.calendar_id,
                  params.event_id,
                  params.attendee_ids,
                ),
              );
            }

            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          const authResp = await handleFeishuTokenError(err, firstAccount, redirectUri, getOAuthDirectSender(firstAccount));
          // oxlint-disable-next-line typescript/no-explicit-any
          const axiosData = (err as any)?.response?.data;
          if (axiosData?.code && axiosData?.msg) {
            if (authResp) {return authResp;}

            return json({
              error: `Feishu API error ${axiosData.code}: ${axiosData.msg}`,
              field_violations: axiosData.error?.field_violations,
            });
          }
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    }),
    { name: "feishu_calendar" },
  );
  api.logger.info?.("feishu: registered feishu_calendar tool (user_access_token mode)");
}
