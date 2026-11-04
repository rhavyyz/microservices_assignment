/**
 * Formatação de datas e valores. As APIs usam formatos diferentes: Eventos devolve ISO 8601 ("...T...Z"); Inscrições
 * devolve `str(datetime)` do Python ("2026-11-03 23:25:45.175467+00:00"). `parseApiDate` aceita os dois.
 */
/**
 * Converte "YYYY-MM-DD HH:MM:SS…" (str(datetime) do Python) em ISO 8601 ("…T…"). O V8 aceita o formato com espaço,
 * mas Safari e outros motores não: sem isto, as datas de Inscrições apareceriam como "Invalid Date" nesses navegadores.
 */
export function normalizeApiDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d/.test(value) ? value.replace(' ', 'T') : value;
}

export function parseApiDate(value: string): Date {
  return new Date(normalizeApiDate(value));
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' });
const timeOnly = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' });

export function formatDateTime(value: string): string {
  const d = parseApiDate(value);
  return Number.isNaN(d.getTime()) ? value : dateTime.format(d);
}

/** "10 de março de 2027, 09:00 até 12 de março de 2027, 18:00" (ou só o horário final se for no mesmo dia). */
export function formatPeriod(startsAt: string, endsAt: string): string {
  const s = parseApiDate(startsAt);
  const e = parseApiDate(endsAt);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${startsAt} – ${endsAt}`;
  const sameDay = dateOnly.format(s) === dateOnly.format(e);
  return sameDay
    ? `${dateTime.format(s)} às ${timeOnly.format(e)}`
    : `${dateTime.format(s)} até ${dateTime.format(e)}`;
}

/** Centavos -> "R$ 50,00"; zero -> "Gratuita". */
export function formatPrice(cents: number, currency = 'BRL'): string {
  if (cents === 0) return 'Gratuita';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100);
}

/**
 * Valor em centavos com a moeda, sem o "Gratuita" do preço: serve para receita e reembolso (zero é um valor).
 * Relatórios agrupa pagamentos sem moeda como "UNKNOWN", que o Intl recusa; nesse caso mostra o código ao lado.
 */
export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }
}

/** Taxa 0–1 -> "75,0%"; ausente (denominador zero no serviço) -> "—". */
export function formatRate(rate: number | null): string {
  return rate === null
    ? '—'
    : `${(rate * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function hasEnded(endsAt: string, now: Date = new Date()): boolean {
  const e = parseApiDate(endsAt);
  return !Number.isNaN(e.getTime()) && e.getTime() <= now.getTime();
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
