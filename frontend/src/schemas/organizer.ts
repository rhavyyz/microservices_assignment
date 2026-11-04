import { z } from 'zod';
import type { ActivityInput, EventInput } from '../api/eventsApi';

/**
 * Formulários do organizador. Os campos são texto (é o que os inputs entregam); `toEventInput`/`toActivityInput`
 * convertem para o contrato do serviço de Eventos (ISO 8601 em UTC, valores em centavos). Os limites espelham
 * events/src/http/schemas.ts; a validação do servidor continua valendo (ver CODE_MESSAGES para os erros de regra).
 */
const required = (label: string, max: number) =>
  z.string().trim().min(1, `Informe ${label}.`).max(max, `Use no máximo ${max} caracteres.`);
const optional = (max: number) => z.string().trim().max(max, `Use no máximo ${max} caracteres.`);

const dateTimeLocal = (label: string) =>
  z
    .string()
    .min(1, `Informe ${label}.`)
    .refine((v) => !Number.isNaN(new Date(v).getTime()), `Informe ${label} válida.`);

const httpsUrl = z
  .string()
  .trim()
  .max(2000, 'Use no máximo 2000 caracteres.')
  .refine((v) => {
    if (v === '') return true;
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Informe um endereço seguro (começando com https).');

const periodOk = (d: { startsAt: string; endsAt: string }) =>
  new Date(d.endsAt).getTime() > new Date(d.startsAt).getTime();
const PERIOD_ERROR = { path: ['endsAt'], message: 'O término deve ser depois do início.' };

export const eventFormSchema = z
  .object({
    title: required('o título', 200),
    organization: optional(200),
    description: optional(5000),
    location: optional(300),
    bannerUrl: httpsUrl,
    startsAt: dateTimeLocal('a data de início'),
    endsAt: dateTimeLocal('a data de término'),
  })
  .refine(periodOk, PERIOD_ERROR);

/** Preço em reais ("50", "50,00", "50.5"); vazio = gratuita. */
const PRICE = /^\d{1,6}([.,]\d{1,2})?$/;

export const activityFormSchema = z
  .object({
    title: required('o título', 200),
    description: optional(5000),
    speaker: optional(200),
    location: optional(300),
    startsAt: dateTimeLocal('a data de início'),
    endsAt: dateTimeLocal('a data de término'),
    price: z
      .string()
      .trim()
      .refine((v) => v === '' || PRICE.test(v), 'Informe o valor em reais, por exemplo 50,00.')
      .refine((v) => v === '' || reaisToCents(v) <= 100_000_000, 'Valor acima do máximo.'),
    capacity: z
      .string()
      .trim()
      .regex(/^\d+$/, 'Informe a capacidade (número inteiro).')
      .refine(
        (v) => Number(v) >= 1 && Number(v) <= 100_000,
        'A capacidade deve ficar entre 1 e 100000.',
      ),
    waitlistEnabled: z.boolean(),
  })
  .refine(periodOk, PERIOD_ERROR);

export type EventForm = z.infer<typeof eventFormSchema>;
export type ActivityForm = z.infer<typeof activityFormSchema>;

/** Valor de <input type="datetime-local"> (horário local, sem fuso) -> instante ISO 8601 em UTC. */
export function localToIso(value: string): string {
  return new Date(value).toISOString();
}

/** ISO 8601 -> valor de <input type="datetime-local"> no horário local do navegador. */
export function isoToLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "50,5" -> 5050. Sem ponto flutuante: separa reais e centavos como texto. */
export function reaisToCents(value: string): number {
  const v = value.trim();
  if (v === '') return 0;
  const [reais = '0', frac = ''] = v.replace(',', '.').split('.');
  return Number(reais) * 100 + Number(frac.padEnd(2, '0'));
}

/** 5050 -> "50,50"; 0 -> "". */
export function centsToReais(cents: number): string {
  if (cents === 0) return '';
  return `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

const nullIfEmpty = (v: string): string | null => (v.trim() === '' ? null : v.trim());

export function toEventInput(f: EventForm): EventInput {
  return {
    title: f.title,
    organization: nullIfEmpty(f.organization),
    description: nullIfEmpty(f.description),
    location: nullIfEmpty(f.location),
    banner_url: nullIfEmpty(f.bannerUrl),
    starts_at: localToIso(f.startsAt),
    ends_at: localToIso(f.endsAt),
  };
}

export function toActivityInput(f: ActivityForm): ActivityInput {
  return {
    title: f.title,
    description: nullIfEmpty(f.description),
    speaker: nullIfEmpty(f.speaker),
    location: nullIfEmpty(f.location),
    starts_at: localToIso(f.startsAt),
    ends_at: localToIso(f.endsAt),
    amount_minor: reaisToCents(f.price),
    waitlist_enabled: f.waitlistEnabled,
    capacity: Number(f.capacity),
  };
}
