import type { Activity, EventItem, EventStatus } from '../api/eventsSchemas';
import { centsToReais, isoToLocal, type ActivityForm, type EventForm } from '../schemas/organizer';

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  DRAFT: 'Rascunho',
  PUBLISHED: 'Publicado',
  CANCELLED: 'Cancelado',
};

export const EVENT_STATUS_TONE: Record<EventStatus, 'ok' | 'wait' | 'off'> = {
  DRAFT: 'wait',
  PUBLISHED: 'ok',
  CANCELLED: 'off',
};

export function eventDefaults(e?: EventItem): EventForm {
  return {
    title: e?.title ?? '',
    organization: e?.organization ?? '',
    description: e?.description ?? '',
    location: e?.location ?? '',
    bannerUrl: e?.banner_url ?? '',
    startsAt: e ? isoToLocal(e.starts_at) : '',
    endsAt: e ? isoToLocal(e.ends_at) : '',
  };
}

export function activityDefaults(a?: Activity): ActivityForm {
  return {
    title: a?.title ?? '',
    description: a?.description ?? '',
    speaker: a?.speaker ?? '',
    location: a?.location ?? '',
    startsAt: a ? isoToLocal(a.starts_at) : '',
    endsAt: a ? isoToLocal(a.ends_at) : '',
    price: a ? centsToReais(a.amount_minor) : '',
    capacity: a ? String(a.capacity) : '',
    waitlistEnabled: a?.waitlist_enabled ?? false,
  };
}
