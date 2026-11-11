import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatPeriod,
  formatMoney,
  formatPrice,
  formatRate,
  hasEnded,
  isUuid,
  normalizeApiDate,
  parseApiDate,
} from './format';

describe('normalizeApiDate', () => {
  it('troca o espaço do str(datetime) do Python por "T" (necessário em Safari) e não mexe em ISO', () => {
    expect(normalizeApiDate('2026-11-03 23:25:45.175467+00:00')).toBe(
      '2026-11-03T23:25:45.175467+00:00',
    );
    expect(normalizeApiDate('2026-11-03T23:25:45.175Z')).toBe('2026-11-03T23:25:45.175Z');
    expect(normalizeApiDate('texto qualquer com espaço')).toBe('texto qualquer com espaço');
  });
});

describe('parseApiDate', () => {
  it('entende ISO 8601 (Eventos) e str(datetime) do Python (Inscrições) como o mesmo instante', () => {
    const iso = parseApiDate('2026-11-03T23:25:45.175Z');
    const py = parseApiDate('2026-11-03 23:25:45.175000+00:00');
    expect(py.getTime()).toBe(iso.getTime());
    expect(Number.isNaN(parseApiDate('2026-11-03 23:25:45+00:00').getTime())).toBe(false);
  });

  it('data inválida não quebra: devolve o texto recebido', () => {
    expect(formatDateTime('lixo')).toBe('lixo');
    expect(formatPeriod('x', 'y')).toBe('x – y');
  });
});

describe('formatPeriod', () => {
  it('mesmo dia mostra só o horário final; dias diferentes mostram as duas pontas', () => {
    expect(formatPeriod('2099-03-10T13:00:00Z', '2099-03-10T15:00:00Z')).toContain(' às ');
    expect(formatPeriod('2099-03-10T13:00:00Z', '2099-03-12T15:00:00Z')).toContain(' até ');
  });
});

describe('formatPrice', () => {
  it('formata centavos em reais e trata zero como gratuita', () => {
    expect(formatPrice(5000)).toMatch(/R\$\s?50,00/);
    expect(formatPrice(12345)).toMatch(/R\$\s?123,45/);
    expect(formatPrice(0)).toBe('Gratuita');
  });
});

describe('hasEnded e isUuid', () => {
  it('compara com o instante informado', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    expect(hasEnded('2029-12-31T23:59:59Z', now)).toBe(true);
    expect(hasEnded('2030-01-01T00:00:01Z', now)).toBe(false);
  });
  it('valida UUID', () => {
    expect(isUuid('00ec3dc4-9986-4159-b37f-9cc1087b9203')).toBe(true);
    expect(isUuid('nao-e-uuid')).toBe(false);
    expect(isUuid('../etc/passwd')).toBe(false);
  });
});

describe('formatMoney', () => {
  it('formata centavos na moeda, e zero é um valor (não "Gratuita")', () => {
    expect(formatMoney(2500, 'BRL')).toMatch(/R\$\s*25,00/);
    expect(formatMoney(0, 'BRL')).toMatch(/R\$\s*0,00/);
    expect(formatMoney(1000, 'USD')).toMatch(/US\$\s*10,00/);
  });

  it('moeda que o Intl recusa (UNKNOWN de Relatórios) mostra o código, sem lançar', () => {
    expect(formatMoney(1500, 'UNKNOWN')).toBe('15,00 UNKNOWN');
  });
});

describe('formatRate', () => {
  it('taxa em porcentagem com uma casa; null vira travessão; zero é 0,0%', () => {
    expect(formatRate(0.75)).toBe('75,0%');
    expect(formatRate(0.6667)).toBe('66,7%');
    expect(formatRate(0)).toBe('0,0%');
    expect(formatRate(1)).toBe('100,0%');
    expect(formatRate(null)).toBe('—');
  });
});
