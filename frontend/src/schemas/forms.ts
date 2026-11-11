import { z } from 'zod';

/**
 * Validação no cliente, espelhando as regras do backend (a validação do servidor continua obrigatória):
 * nome 2–120 sem caracteres de controle; e-mail ASCII; senha 10–72 caracteres e no máximo 72 bytes UTF-8
 * (limite do BCrypt, recusado em vez de truncado).
 */
export const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

const name = z
  .string()
  .trim()
  .min(2, 'Informe um nome com pelo menos 2 caracteres.')
  .max(120, 'O nome deve ter no máximo 120 caracteres.')
  .refine((v) => !CONTROL_CHARS.test(v), 'O nome não pode conter caracteres de controle.');

const email = z
  .string()
  .trim()
  .min(1, 'Informe o e-mail.')
  .max(254, 'O e-mail deve ter no máximo 254 caracteres.')
  .regex(EMAIL_PATTERN, 'Informe um e-mail válido.');

export const registerSchema = z
  .object({
    name,
    email,
    password: z
      .string()
      .min(10, 'A senha deve ter pelo menos 10 caracteres.')
      .max(72, 'A senha deve ter no máximo 72 caracteres.')
      .refine((v) => utf8Bytes(v) <= 72, 'A senha deve ter no máximo 72 bytes (UTF-8).'),
    confirmPassword: z.string().min(1, 'Confirme a senha.'),
    accountType: z.enum(['PARTICIPANT', 'ORGANIZER']),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'As senhas não conferem.',
  });

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Informe a senha.').max(128, 'A senha é muito longa.'),
});

export const profileSchema = z.object({ name });

/** Busca de usuários: ao menos um filtro, como no backend (GET /users). */
export const searchSchema = z
  .object({
    id: z
      .string()
      .trim()
      .refine((v) => v === '' || UUID_PATTERN.test(v), 'Informe um UUID válido.'),
    email: z
      .string()
      .trim()
      .refine(
        (v) => v === '' || v.length >= 3,
        'O filtro de e-mail deve ter pelo menos 3 caracteres.',
      )
      .refine((v) => v.length <= 254, 'O filtro de e-mail deve ter no máximo 254 caracteres.'),
    name: z
      .string()
      .trim()
      .refine(
        (v) => v === '' || v.length >= 2,
        'O filtro de nome deve ter pelo menos 2 caracteres.',
      )
      .refine((v) => v.length <= 120, 'O filtro de nome deve ter no máximo 120 caracteres.'),
  })
  .refine((d) => d.id !== '' || d.email !== '' || d.name !== '', {
    path: ['name'],
    message: 'Informe ao menos um filtro: id, e-mail ou nome.',
  });

export type RegisterForm = z.infer<typeof registerSchema>;
export type LoginForm = z.infer<typeof loginSchema>;
export type ProfileForm = z.infer<typeof profileSchema>;
export type SearchForm = z.infer<typeof searchSchema>;
