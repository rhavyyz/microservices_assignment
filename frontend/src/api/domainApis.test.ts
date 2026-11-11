import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../services/createServices';
import {
  activity,
  availability,
  eventDetail,
  eventPage,
  registration,
  ACTIVITY_ID,
  EVENT_ID,
  REGISTRATION_ID,
} from '../test/fixtures';
import { jsonResponse } from '../test/helpers';
import { ActivitySchema, EventDetailSchema, EventPageSchema } from './eventsSchemas';
import { AvailabilitySchema, RegistrationSchema } from './subscriptionSchemas';

function setup(body: unknown) {
  const f = vi.fn<typeof fetch>(async () => jsonResponse(200, body));
  const { eventsApi, subscriptionApi, session } = createServices(
    { apiBaseUrl: 'https://gw.test' },
    f,
  );
  session.setToken('tok');
  return { f, eventsApi, subscriptionApi };
}
const call = (f: ReturnType<typeof setup>['f']) => {
  const [url, init] = f.mock.calls[0]!;
  return {
    url: new URL(String(url)),
    init: init as RequestInit,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
};

describe('API de Eventos (leitura pública, sem token)', () => {
  it('listEvents chama /events/api/v1/events com os filtros e SEM Authorization, mesmo com sessão ativa', async () => {
    const { f, eventsApi } = setup(eventPage([]));
    await eventsApi.listEvents({
      q: 'react',
      from: '2099-01-01T00:00:00.000Z',
      limit: 12,
      offset: 24,
    });
    const c = call(f);
    expect(c.url.origin + c.url.pathname).toBe('https://gw.test/events/api/v1/events');
    expect(Object.fromEntries(c.url.searchParams)).toEqual({
      q: 'react',
      from: '2099-01-01T00:00:00.000Z',
      limit: '12',
      offset: '24',
    });
    expect(c.headers['Authorization']).toBeUndefined();
  });

  it('getEvent e getActivity usam os caminhos do serviço', async () => {
    const a = setup(eventDetail());
    await a.eventsApi.getEvent(EVENT_ID);
    expect(call(a.f).url.pathname).toBe(`/events/api/v1/events/${EVENT_ID}`);
    const b = setup(activity());
    await b.eventsApi.getActivity(ACTIVITY_ID);
    expect(call(b.f).url.pathname).toBe(`/events/api/v1/activities/${ACTIVITY_ID}`);
  });

  it('os schemas aceitam o formato real e rejeitam o que foge do contrato', () => {
    expect(
      EventPageSchema.safeParse(eventPage([{ ...eventDetail(), activities: undefined }])).success,
    ).toBe(true);
    expect(EventDetailSchema.safeParse(eventDetail()).success).toBe(true);
    expect(ActivitySchema.safeParse(activity()).success).toBe(true);
    expect(ActivitySchema.safeParse({ ...activity(), amount_minor: '5000' }).success).toBe(false);
    // Contrato antigo (id, price_cents, available) não é mais aceito.
    const { activity_id: _id, amount_minor: _amount, ...legacy } = activity();
    void _id;
    void _amount;
    expect(
      ActivitySchema.safeParse({ ...legacy, id: ACTIVITY_ID, price_cents: 5000, available: 3 })
        .success,
    ).toBe(false);
    expect(ActivitySchema.safeParse(activity({ lifecycle: 'PAUSED' })).success).toBe(false);
    expect(EventDetailSchema.safeParse({ ...eventDetail(), status: 'ARCHIVED' }).success).toBe(
      false,
    );
  });
});

describe('API de Inscrições (sempre autenticada)', () => {
  it('createRegistration faz POST com join_waitlist e Bearer', async () => {
    const { f, subscriptionApi } = setup(registration());
    await subscriptionApi.createRegistration(ACTIVITY_ID, true);
    const c = call(f);
    expect(c.url.pathname).toBe(`/subscription/api/v1/activities/${ACTIVITY_ID}/registrations`);
    expect(c.init.method).toBe('POST');
    expect(JSON.parse(String(c.init.body))).toEqual({ join_waitlist: true });
    expect(c.headers['Authorization']).toBe('Bearer tok');
  });

  it('getAvailability faz GET autenticado e o schema aceita o formato real', async () => {
    const { f, subscriptionApi } = setup(availability());
    const a = await subscriptionApi.getAvailability(ACTIVITY_ID);
    expect(a.available).toBe(12);
    const c = call(f);
    expect(c.url.pathname).toBe(`/subscription/api/v1/activities/${ACTIVITY_ID}/availability`);
    expect(c.headers['Authorization']).toBe('Bearer tok');
    expect(AvailabilitySchema.safeParse({ ...availability(), available: 'muitas' }).success).toBe(
      false,
    );
  });

  it('listMine desembrulha {registrations} e envia limit/offset', async () => {
    const { f, subscriptionApi } = setup({ registrations: [registration()] });
    const list = await subscriptionApi.listMine({ limit: 20, offset: 40 });
    expect(list).toHaveLength(1);
    const c = call(f);
    expect(c.url.pathname).toBe('/subscription/api/v1/registrations/me');
    expect(Object.fromEntries(c.url.searchParams)).toEqual({ limit: '20', offset: '40' });
  });

  it('cancelar e aceitar oferta fazem POST sem corpo e sem Content-Type', async () => {
    for (const [fn, suffix] of [
      ['cancelRegistration', 'cancel'],
      ['acceptOffer', 'accept-offer'],
    ] as const) {
      const { f, subscriptionApi } = setup(registration({ status: 'CANCELLED' }));
      await subscriptionApi[fn](REGISTRATION_ID);
      const c = call(f);
      expect(c.url.pathname).toBe(
        `/subscription/api/v1/registrations/${REGISTRATION_ID}/${suffix}`,
      );
      expect(c.init.method).toBe('POST');
      expect(c.init.body).toBeNull();
      expect(c.headers['Content-Type']).toBeUndefined();
    }
  });

  it('o schema aceita as datas do Python e inscrições antigas sem parent_event_id', () => {
    expect(RegistrationSchema.safeParse(registration()).success).toBe(true);
    const { parent_event_id: _omit, ...legacy } = registration();
    void _omit;
    expect(RegistrationSchema.safeParse(legacy).success).toBe(true);
    expect(RegistrationSchema.safeParse(registration({ status: 'PAID' })).success).toBe(false);
  });
});
