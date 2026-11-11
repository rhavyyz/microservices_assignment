import { z } from 'zod';
import { API_PATHS } from '../config';
import type { ApiClient } from './client';

/** Certificados (certificates/app/schemas/certificate.py). `event_id` é nulo só em certificados antigos, por atividade. */
export const CertificateSchema = z.object({
  id: z.guid(),
  registration_id: z.guid(),
  activity_id: z.guid(),
  event_id: z.guid().nullable(),
  issued_at: z.string(),
});
export const CertificateListSchema = z.object({ certificates: z.array(CertificateSchema) });

export type Certificate = z.infer<typeof CertificateSchema>;

/**
 * Certificados do próprio usuário. Não há como criar: o serviço os emite sozinho ao consumir `AttendanceEligible`
 * (evento encerrado e presença mínima de 75%). O PDF exige o token, então é baixado por fetch e entregue como Blob;
 * um link simples não enviaria o Authorization.
 */
export function createCertificatesApi(
  client: ApiClient,
  basePath: string = API_PATHS.certificates,
) {
  return {
    listMine(
      params: { limit?: number; offset?: number } = {},
      signal?: AbortSignal,
    ): Promise<Certificate[]> {
      return client
        .request({
          path: `${basePath}/me`,
          query: { limit: params.limit, offset: params.offset },
          auth: true,
          schema: CertificateListSchema,
          localMessages: true,
          signal,
        })
        .then((r) => r.certificates);
    },

    downloadPdf(certificateId: string, signal?: AbortSignal): Promise<Blob> {
      return client.requestBlob(
        {
          path: `${basePath}/${encodeURIComponent(certificateId)}`,
          auth: true,
          localMessages: true,
          signal,
        },
        'application/pdf',
      );
    },
  };
}

export type CertificatesApi = ReturnType<typeof createCertificatesApi>;
