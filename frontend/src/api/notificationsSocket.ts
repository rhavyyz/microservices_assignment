import { z } from 'zod';
import { NotificationSchema, type AppNotification } from './notificationsSchemas';

/**
 * Conexão em tempo real com o Gateway: `GET /ws?access_token=<JWT>` (gateway/ws.go). O navegador não consegue
 * enviar o cabeçalho Authorization num WebSocket, então o token vai na URL, que o Gateway aceita e não registra
 * (só o caminho); por isso a conexão só existe sobre TLS em produção. Quadros (gateway/push.go):
 *   {"type":"connected"}                        primeiro quadro, depois do upgrade
 *   {"type":"notification","notification":{…}}  notificação nova do usuário
 * Há uma conexão por usuário: abrir outra (outra aba) fecha esta com o código 4000, e aqui NÃO reconectamos
 * nesse caso, para duas abas não ficarem derrubando uma à outra. O código 4001 (fila cheia) reconecta.
 */
export const CLOSE_REPLACED = 4000;
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

const FrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected') }),
  z.object({ type: z.literal('notification'), notification: NotificationSchema }),
]);

type WebSocketCtor = new (url: string) => WebSocket;

export interface NotificationsSocketOptions {
  /** URL base do Gateway, sem barra final (https://… ou http://…). */
  baseUrl: string;
  /** Token em memória; sem token, não conecta. */
  getToken: () => string | null;
  onNotification: (n: AppNotification) => void;
  /** `true` quando o Gateway confirma a conexão; `false` quando cai. */
  onLive?: (live: boolean) => void;
  WebSocketImpl?: WebSocketCtor;
}

export function socketUrl(baseUrl: string, token: string): string {
  const u = new URL('/ws', baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('access_token', token);
  return u.toString();
}

export class NotificationsSocket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;

  constructor(private readonly opts: NotificationsSocketOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close();
    }
    this.opts.onLive?.(false);
  }

  private connect(): void {
    const token = this.opts.getToken();
    const Impl = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    if (this.stopped || !token || typeof Impl !== 'function') return;
    let ws: WebSocket;
    try {
      ws = new Impl(socketUrl(this.opts.baseUrl, token));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const frame = FrameSchema.safeParse(parsed);
      if (!frame.success) return; // quadro desconhecido: ignora
      if (frame.data.type === 'connected') {
        this.attempt = 0;
        this.opts.onLive?.(true);
      } else {
        this.opts.onNotification(frame.data.notification);
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      this.opts.onLive?.(false);
      if (!this.stopped && ev.code !== CLOSE_REPLACED) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // O fechamento (onclose) que se segue cuida da reconexão.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
