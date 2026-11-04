import { describe, expect, it } from 'vitest';
import { loginSchema, profileSchema, registerSchema, searchSchema } from './forms';

const okRegister = {
  name: 'Maria Silva',
  email: 'maria@example.com',
  password: 'senha-forte-123',
  confirmPassword: 'senha-forte-123',
};
const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.error?.issues.map((i) => i.message) ?? [];

describe('registerSchema', () => {
  it('aceita dados válidos e remove espaços das pontas de nome e e-mail', () => {
    const r = registerSchema.parse({
      ...okRegister,
      name: '  Maria Silva ',
      email: ' maria@example.com ',
    });
    expect(r.name).toBe('Maria Silva');
    expect(r.email).toBe('maria@example.com');
  });

  it('exige campos preenchidos', () => {
    const r = registerSchema.safeParse({ name: '', email: '', password: '', confirmPassword: '' });
    expect(r.success).toBe(false);
    expect(messages(r)).toEqual(
      expect.arrayContaining(['Informe um nome com pelo menos 2 caracteres.', 'Informe o e-mail.']),
    );
  });

  it.each(['sem-arroba', 'a@b', 'a@@b.com', 'a b@c.com', '@x.com', 'a@.com', 'josé@example.com'])(
    'rejeita o e-mail %s',
    (email) => {
      expect(registerSchema.safeParse({ ...okRegister, email }).success).toBe(false);
    },
  );

  it('aplica a política de senha: 10 a 72 caracteres e no máximo 72 bytes', () => {
    const pw = (password: string) =>
      registerSchema.safeParse({ ...okRegister, password, confirmPassword: password });
    expect(pw('curta').success).toBe(false);
    expect(pw('x'.repeat(10)).success).toBe(true);
    expect(pw('x'.repeat(72)).success).toBe(true);
    expect(pw('x'.repeat(73)).success).toBe(false);
    const bytes = pw('é'.repeat(40)); // 40 caracteres, 80 bytes em UTF-8
    expect(bytes.success).toBe(false);
    expect(messages(bytes)).toContain('A senha deve ter no máximo 72 bytes (UTF-8).');
  });

  it('exige a confirmação igual à senha', () => {
    const r = registerSchema.safeParse({ ...okRegister, confirmPassword: 'outra-senha-123' });
    expect(messages(r)).toContain('As senhas não conferem.');
  });

  it('rejeita nome curto, longo ou com caracteres de controle', () => {
    for (const name of ['a', 'x'.repeat(121), 'Ma\nria']) {
      expect(registerSchema.safeParse({ ...okRegister, name }).success).toBe(false);
    }
  });
});

describe('loginSchema', () => {
  it('valida e-mail e exige senha', () => {
    expect(loginSchema.safeParse({ email: 'maria@example.com', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: 'maria', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'maria@example.com', password: '' }).success).toBe(false);
  });
});

describe('profileSchema', () => {
  it('aplica as regras de nome', () => {
    expect(profileSchema.safeParse({ name: 'Ma' }).success).toBe(true);
    expect(profileSchema.safeParse({ name: ' ' }).success).toBe(false);
  });
});

describe('searchSchema', () => {
  const blank = { id: '', email: '', name: '' };
  it('exige ao menos um filtro', () => {
    expect(messages(searchSchema.safeParse(blank))).toContain(
      'Informe ao menos um filtro: id, e-mail ou nome.',
    );
    expect(searchSchema.safeParse({ ...blank, name: 'Ana' }).success).toBe(true);
    expect(searchSchema.safeParse({ ...blank, email: 'gma' }).success).toBe(true);
    expect(
      searchSchema.safeParse({ ...blank, id: '00ec3dc4-9986-4159-b37f-9cc1087b9203' }).success,
    ).toBe(true);
  });
  it('valida tamanho mínimo dos filtros e formato do id', () => {
    expect(searchSchema.safeParse({ ...blank, name: 'a' }).success).toBe(false);
    expect(searchSchema.safeParse({ ...blank, email: 'ab' }).success).toBe(false);
    expect(searchSchema.safeParse({ ...blank, id: 'nao-e-uuid' }).success).toBe(false);
  });
});
