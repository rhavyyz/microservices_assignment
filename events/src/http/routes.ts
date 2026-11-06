import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../domain/model.ts';
import { unauthorized } from '../errors.ts';
import type { ActivityInput, ActivityPatch, EventInput, EventPatch, EventService } from '../services/events.ts';
import type { AuthedCtx } from '../services/unit-of-work.ts';
import { actorFromHeaders } from './identity.ts';
import { toListQuery, withDates } from './input.ts';
import {
  activityListSchema, activityParams, activitySchema, createActivityBody, createEventBody, eventDetailSchema,
  eventPageSchema, eventParams, eventSchema, listQuery, patchActivityBody, patchEventBody, permissionsSchema,
} from './schemas.ts';

const EVENTS = ['Events'];
const SCHEDULE = ['Schedule'];

const API = '/api/v1';
/** Route option: the route needs an identity (checked before the body is validated). */
const AUTH = { config: { auth: true } };

// Gateway settings, declared on each operation (`x-gateway`); the gateway reads them from /openapi.json when it first creates the endpoint.
/** Public through the gateway; a token is optional (the identity is forwarded when present). */
const PUBLIC_OPTIONAL_AUTH = { 'x-gateway': { isPublic: true, requireAuth: false } } as const;
/** Public through the gateway, valid JWT required. */
const PUBLIC_AUTH = { 'x-gateway': { isPublic: true, requireAuth: true } } as const;
/** Service-to-service only: hidden by the gateway. */
const INTERNAL = { 'x-gateway': { isPublic: false, requireAuth: false } } as const;

/**
 * Public reads take an optional identity (an organizer also sees their drafts); every change needs one.
 * The identity is the gateway's X-User-Id / X-User-Roles (see identity.ts). Authorization by resource (RN07)
 * is done by the use cases, not here.
 */
export function registerRoutes(app: FastifyInstance, deps: { events: EventService }) {
  const { events } = deps;

  /** The caller from the gateway headers, or null when anonymous (an invalid X-User-Id is still a 401). */
  const viewer = (req: FastifyRequest): Actor | null => actorFromHeaders(req.headers);

  function authed(req: FastifyRequest): AuthedCtx {
    const actor = viewer(req);
    if (!actor) throw unauthorized();
    return { actor, traceId: req.id };
  }

  // The headers are judged before anything else, on every business route: an invalid X-User-Id is a 401 even
  // on a public read, and a route marked AUTH without identity is a 401 before its body is validated.
  app.addHook('onRequest', async (req) => {
    if (!req.routeOptions.url?.startsWith(API)) return;
    const actor = viewer(req);
    if (!actor && (req.routeOptions.config as { auth?: boolean }).auth) throw unauthorized();
  });

  const eventId = (req: FastifyRequest) => (req.params as { event_id: string }).event_id;
  const activityId = (req: FastifyRequest) => (req.params as { activity_id: string }).activity_id;

  // ---- Consult and search (RF04) ------------------------------------------------------------------

  app.get(`${API}/events`, {
    schema: { ...PUBLIC_OPTIONAL_AUTH, summary: 'Search published events', tags: EVENTS, querystring: listQuery, response: { 200: eventPageSchema } },
  }, async (req) => events.listPublished(toListQuery(req.query)));

  app.get(`${API}/me/events`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: "The caller's own events, drafts included", tags: EVENTS, querystring: listQuery, response: { 200: eventPageSchema } },
  }, async (req) => events.listOwn(authed(req).actor, toListQuery(req.query)));

  app.get(`${API}/events/:event_id`, {
    schema: { ...PUBLIC_OPTIONAL_AUTH, summary: 'An event with its schedule', tags: EVENTS, params: eventParams, response: { 200: eventDetailSchema } },
  }, async (req) => events.getEvent(viewer(req), eventId(req)));

  app.get(`${API}/events/:event_id/activities`, {
    schema: { ...PUBLIC_OPTIONAL_AUTH, summary: "An event's schedule", tags: SCHEDULE, params: eventParams, response: { 200: activityListSchema } },
  }, async (req) => ({ items: await events.listEventActivities(viewer(req), eventId(req)) }));

  app.get(`${API}/activities/:activity_id`, {
    schema: { ...PUBLIC_OPTIONAL_AUTH, summary: 'An activity, with its lifecycle and whether registration is open', tags: SCHEDULE, params: activityParams, response: { 200: activitySchema } },
  }, async (req) => events.getActivity(viewer(req), activityId(req)));

  // Called by Subscription (through the discoverer, not the gateway) before every administrative operation.
  app.get(`${API}/activities/:activity_id/permissions/me`, {
    ...AUTH,
    schema: { ...INTERNAL, summary: 'Whether the caller administers the activity (organizer of its event)', tags: SCHEDULE, params: activityParams, response: { 200: permissionsSchema } },
  }, async (req) => events.getPermissions(authed(req).actor, activityId(req)));

  // ---- Events (RF02) ------------------------------------------------------------------------------

  app.post(`${API}/events`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: 'Create a draft event (organizers)', tags: EVENTS, body: createEventBody, response: { 201: eventSchema } },
  }, async (req, reply) => {
    const created = await events.createEvent(authed(req), withDates<EventInput>(req.body));
    return reply.code(201).send(created);
  });

  app.patch(`${API}/events/:event_id`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: 'Edit an event (its organizer)', tags: EVENTS, params: eventParams, body: patchEventBody, response: { 200: eventSchema } },
  }, async (req) => events.updateEvent(authed(req), eventId(req), withDates<EventPatch>(req.body)));

  app.post(`${API}/events/:event_id/publish`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: 'Publish a draft event (its organizer)', tags: EVENTS, params: eventParams, response: { 200: eventSchema } },
  }, async (req) => events.publishEvent(authed(req), eventId(req)));

  app.post(`${API}/events/:event_id/cancel`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: 'Cancel an event (its organizer)', tags: EVENTS, params: eventParams, response: { 200: eventSchema } },
  }, async (req) => events.cancelEvent(authed(req), eventId(req)));

  // ---- Schedule (RF03) ----------------------------------------------------------------------------

  app.post(`${API}/events/:event_id/activities`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: 'Add an activity to the schedule (its organizer)', tags: SCHEDULE, params: eventParams, body: createActivityBody, response: { 201: activitySchema } },
  }, async (req, reply) => {
    const created = await events.addActivity(authed(req), eventId(req), withDates<ActivityInput>(req.body));
    return reply.code(201).send(created);
  });

  app.patch(`${API}/activities/:activity_id`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: 'Edit an activity; capacity is immutable (its organizer)', tags: SCHEDULE, params: activityParams, body: patchActivityBody, response: { 200: activitySchema } },
  }, async (req) => events.updateActivity(authed(req), activityId(req), withDates<ActivityPatch>(req.body)));

  app.post(`${API}/activities/:activity_id/end`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: 'End an activity after its scheduled end (its organizer); repeating it is a no-op', tags: SCHEDULE, params: activityParams, response: { 200: activitySchema } },
  }, async (req) => events.endActivity(authed(req), activityId(req)));

  app.delete(`${API}/activities/:activity_id`, {
    ...AUTH,
    schema: { ...PUBLIC_AUTH, summary: 'Remove an activity of a draft event (its organizer)', tags: SCHEDULE, params: activityParams, response: { 204: { type: 'null' } } },
  }, async (req, reply) => {
    await events.deleteActivity(authed(req), activityId(req));
    return reply.code(204).send();
  });
}
