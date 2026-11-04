import { describe, expect, it } from 'vitest';
import {
  activityFormSchema,
  centsToReais,
  eventFormSchema,
  isoToLocal,
  localToIso,
  reaisToCents,
  toActivityInput,
  toEventInput,
} from './organizer';

const okEvent = {
  title: 'Semana',
  organization: '',
  description: '',
  location: '',
  bannerUrl: '',
  startsAt: '2099-03-10T09:00',
  endsAt: '2099-03-12T18:00',
};
const okActivity = {
  title: 'Oficina',
  description: '',
  speaker: '',
  location: '',
  startsAt: '2099-03-10T10:00',
  endsAt: '2099-03-10T12:00',
  price: '',
  capacity: '30',
  waitlistEnabled: false,
};

describe('conversões', () => {
  it('reais <-> centavos sem ponto flutuante', () => {
    expect(reaisToCents('')).toBe(0);
    expect(reaisToCents('50')).toBe(5000);
    expect(reaisToCents('50,5')).toBe(5050);
    expect(reaisToCents('0.07')).toBe(7);
    expect(reaisToCents('19,99')).toBe(1999);
    expect(centsToReais(0)).toBe('');
    expect(centsToReais(5050)).toBe('50,50');
    expect(centsToReais(7)).toBe('0,07');
  });

  it('datetime-local <-> ISO em UTC (ida e volta preserva o minuto)', () => {
    const iso = localToIso('2099-03-10T09:30');
    expect(iso).toMatch(/Z$/);
    expect(isoToLocal(iso)).toBe('2099-03-10T09:30');
    expect(isoToLocal('lixo')).toBe('');
  });
});

describe('formulário de evento', () => {
  it('aceita o mínimo e converte vazios em null', () => {
    const parsed = eventFormSchema.parse(okEvent);
    const input = toEventInput(parsed);
    expect(input).toMatchObject({
      title: 'Semana',
      organization: null,
      description: null,
      location: null,
      banner_url: null,
    });
    expect(input.starts_at).toBe(new Date('2099-03-10T09:00').toISOString());
  });

  it.each([
    ['título vazio', { title: '  ' }, 'title'],
    ['título longo demais', { title: 'x'.repeat(201) }, 'title'],
    ['banner http (não https)', { bannerUrl: 'http://x.com/a.png' }, 'bannerUrl'],
    ['banner que não é URL', { bannerUrl: 'abc' }, 'bannerUrl'],
    ['término igual ao início', { endsAt: '2099-03-10T09:00' }, 'endsAt'],
    ['término antes do início', { endsAt: '2099-03-09T09:00' }, 'endsAt'],
    ['sem data de início', { startsAt: '' }, 'startsAt'],
  ])('recusa %s', (_n, over, field) => {
    const r = eventFormSchema.safeParse({ ...okEvent, ...over });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path[0] === field)).toBe(true);
  });
});

describe('formulário de atividade', () => {
  it('converte preço em centavos, capacidade em número e mantém a lista de espera', () => {
    const input = toActivityInput(
      activityFormSchema.parse({ ...okActivity, price: '50,00', waitlistEnabled: true }),
    );
    expect(input).toMatchObject({ amount_minor: 5000, capacity: 30, waitlist_enabled: true });
    expect(toActivityInput(activityFormSchema.parse(okActivity)).amount_minor).toBe(0);
  });

  it.each([
    ['capacidade zero', { capacity: '0' }, 'capacity'],
    ['capacidade acima do máximo', { capacity: '100001' }, 'capacity'],
    ['capacidade decimal', { capacity: '1.5' }, 'capacity'],
    ['preço com letras', { price: 'cinquenta' }, 'price'],
    ['preço com 3 casas', { price: '1,234' }, 'price'],
    ['término antes do início', { endsAt: '2099-03-10T09:00' }, 'endsAt'],
  ])('recusa %s', (_n, over, field) => {
    const r = activityFormSchema.safeParse({ ...okActivity, ...over });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path[0] === field)).toBe(true);
  });
});
