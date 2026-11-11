import { API_PATHS } from '../config';
import type { ApiClient } from './client';
import { PaymentSchema, type Payment, type SimulateAction } from './paymentsSchemas';

/** Todas as rotas exigem token. Via Gateway: `/payments/payments/...` (o primeiro `payments` é o kind). */
export function createPaymentsApi(client: ApiClient, basePath: string = API_PATHS.payments) {
  const id = encodeURIComponent;
  return {
    /**
     * Inicia o pagamento de uma inscrição em PENDING_PAYMENT. Só o `registration_id` é enviado: valor, moeda e dono
     * vêm de Inscrições, nunca do cliente. Idempotente: se já existe, devolve o mesmo pagamento (200).
     */
    createPayment(registrationId: string, signal?: AbortSignal): Promise<Payment> {
      return client.request({
        method: 'POST',
        path: basePath,
        body: { registration_id: registrationId },
        auth: true,
        schema: PaymentSchema,
        localMessages: true,
        signal,
      });
    },

    getPayment(paymentId: string, signal?: AbortSignal): Promise<Payment> {
      return client.request({
        path: `${basePath}/${id(paymentId)}`,
        auth: true,
        schema: PaymentSchema,
        localMessages: true,
        signal,
      });
    },

    /** Provedor simulado (demonstração). Responde 404 se o simulador estiver desligado e 409 se não aplicou. */
    simulate(paymentId: string, action: SimulateAction, signal?: AbortSignal): Promise<Payment> {
      return client.request({
        method: 'POST',
        path: `${basePath}/${id(paymentId)}/simulate`,
        body: { action },
        auth: true,
        schema: PaymentSchema,
        localMessages: true,
        signal,
      });
    },
  };
}

export type PaymentsApi = ReturnType<typeof createPaymentsApi>;
