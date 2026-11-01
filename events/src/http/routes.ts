import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../domain/model.ts';
import { unauthorized } from '../errors.ts';
import type { ActivityInput, ActivityPatch, EventInput, EventPatch, EventService } from '../services/events.ts';
import type { AuthedCtx } from '../services/unit-of-work.ts';
import { bearerToken, type TokenVerifier } from './auth.ts';
import { toListQuery, withDates } from './input.ts';
import {
  activityListSchema, activityParams, activitySchema, createActivityBody, createEventBody, eventDetailSchema,
  eventPageSchema, eventParams, eventSchema, listQuery, patchActivityBody, patchEventBody,
} from './schemas.ts';

const bearer = [{ bearer: [] }];
const EVENTS = ['Events'];
const SCHEDULE = ['Schedule'];

/**
 * Public reads take an optional token (an organizer also sees their drafts); every change needs one.
 * Authorization by resource (RN07) is done by the use cases, not here.
 */
export function registerRoutes(app: FastifyInstance, deps: { events: EventService; verifyToken: TokenVerifier }) {
  const { events } = deps;

  /** The verified caller, or null without an Authorization header (an invalid token is still a 401). */
  async function viewer(req: FastifyRequest): Promise<Actor | null> {
    const token = bearerToken(req.headers.authorization);
    return token ? deps.verifyToken(token) : null;
  }

  async function authed(req: FastifyRequest): Promise<AuthedCtx> {
    const actor = await viewer(req);
    if (!actor) throw unauthorized();
    return { actor, correlationId: req.id };
  }

  const eventId = (req: FastifyRequest) => (req.params as { eventId: string }).eventId;
  const activityId = (req: FastifyRequest) => (req.params as { activityId: string }).activityId;

  // ---- Consult and search (RF04) ------------------------------------------------------------------

  app.get('/events', {
    schema: { summary: 'Search published events', tags: EVENTS, querystring: listQuery, response: { 200: eventPageSchema } },
  }, async (req) => events.listPublished(toListQuery(req.query)));

  app.get('/me/events', {
    schema: { summary: "The caller's own events, drafts included", tags: EVENTS, security: bearer, querystring: listQuery, response: { 200: eventPageSchema } },
  }, async (req) => events.listOwn((await authed(req)).actor, toListQuery(req.query)));

  app.get('/events/:eventId', {
    schema: { summary: 'An event with its schedule and seats', tags: EVENTS, params: eventParams, response: { 200: eventDetailSchema } },
  }, async (req) => events.getEvent(await viewer(req), eventId(req)));

  app.get('/events/:eventId/activities', {
    schema: { summary: "An event's schedule with available seats", tags: SCHEDULE, params: eventParams, response: { 200: activityListSchema } },
  }, async (req) => ({ items: await events.listEventActivities(await viewer(req), eventId(req)) }));

  app.get('/activities/:activityId', {
    schema: { summary: 'An activity with its available seats', tags: SCHEDULE, params: activityParams, response: { 200: activitySchema } },
  }, async (req) => events.getActivity(await viewer(req), activityId(req)));

  // ---- Events (RF02) ------------------------------------------------------------------------------

  app.post('/events', {
    schema: { summary: 'Create a draft event (organizers)', tags: EVENTS, security: bearer, body: createEventBody, response: { 201: eventSchema } },
  }, async (req, reply) => {
    const created = await events.createEvent(await authed(req), withDates<EventInput>(req.body));
    return reply.code(201).send(created);
  });

  app.patch('/events/:eventId', {
    schema: { summary: 'Edit an event (its organizer)', tags: EVENTS, security: bearer, params: eventParams, body: patchEventBody, response: { 200: eventSchema } },
  }, async (req) => events.updateEvent(await authed(req), eventId(req), withDates<EventPatch>(req.body)));

  app.post('/events/:eventId/publish', {
    schema: { summary: 'Publish a draft event (its organizer)', tags: EVENTS, security: bearer, params: eventParams, response: { 200: eventSchema } },
  }, async (req) => events.publishEvent(await authed(req), eventId(req)));

  app.post('/events/:eventId/cancel', {
    schema: { summary: 'Cancel an event (its organizer)', tags: EVENTS, security: bearer, params: eventParams, response: { 200: eventSchema } },
  }, async (req) => events.cancelEvent(await authed(req), eventId(req)));

  // ---- Schedule (RF03) ----------------------------------------------------------------------------

  app.post('/events/:eventId/activities', {
    schema: { summary: 'Add an activity to the schedule (its organizer)', tags: SCHEDULE, security: bearer, params: eventParams, body: createActivityBody, response: { 201: activitySchema } },
  }, async (req, reply) => {
    const created = await events.addActivity(await authed(req), eventId(req), withDates<ActivityInput>(req.body));
    return reply.code(201).send(created);
  });

  app.patch('/activities/:activityId', {
    schema: { summary: 'Edit an activity; capacity is immutable (its organizer)', tags: SCHEDULE, security: bearer, params: activityParams, body: patchActivityBody, response: { 200: activitySchema } },
  }, async (req) => events.updateActivity(await authed(req), activityId(req), withDates<ActivityPatch>(req.body)));

  app.delete('/activities/:activityId', {
    schema: { summary: 'Remove an activity of a draft event (its organizer)', tags: SCHEDULE, security: bearer, params: activityParams, response: { 204: { type: 'null' } } },
  }, async (req, reply) => {
    await events.deleteActivity(await authed(req), activityId(req));
    return reply.code(204).send();
  });
}
