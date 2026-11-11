import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeFetch, jsonResponse, loginBody, signInTo } from '../test/helpers';

const loginAs = (roles: string[]) =>
  fakeFetch({ 'POST /user/api/v1/auth/login': () => jsonResponse(200, loginBody(roles)) });

describe('Início', () => {
  it('participante vê os atalhos da jornada e não vê a área do organizador', async () => {
    await signInTo(loginAs(['PARTICIPANT']), '/inicio');
    expect(await screen.findByRole('heading', { name: 'Início' })).toBeInTheDocument();
    expect(screen.getByText(/Olá, Maria Silva/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Explorar eventos/ })).toHaveAttribute(
      'href',
      '/eventos',
    );
    expect(screen.getByRole('link', { name: /Acompanhar inscrições/ })).toHaveAttribute(
      'href',
      '/inscricoes',
    );
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: /Notificações/ }),
    ).toHaveAttribute('href', '/notificacoes');
    expect(screen.queryByRole('link', { name: /Buscar usuários/ })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: /Meus certificados/ }),
    ).toHaveAttribute('href', '/certificados');
    expect(screen.queryByText(/Em breve/)).not.toBeInTheDocument();
  });

  it('só o administrador vê o atalho de administração; participante e organizador não', async () => {
    await signInTo(loginAs(['ADMIN']), '/inicio');
    expect(await screen.findByRole('link', { name: /Administração de usuários/ })).toHaveAttribute(
      'href',
      '/admin/usuarios',
    );
    expect(screen.queryByRole('link', { name: /Buscar usuários/ })).not.toBeInTheDocument();
  });

  it('organizador não vê a administração', async () => {
    await signInTo(loginAs(['PARTICIPANT', 'ORGANIZER']), '/inicio');
    await screen.findByRole('heading', { name: 'Início' });
    expect(screen.queryByRole('link', { name: /Administração/ })).not.toBeInTheDocument();
  });

  it('organizador também vê a busca de usuários', async () => {
    await signInTo(loginAs(['PARTICIPANT', 'ORGANIZER']), '/inicio');
    expect(await screen.findByRole('link', { name: /Buscar usuários/ })).toHaveAttribute(
      'href',
      '/usuarios',
    );
  });

  it('o menu muda com a sessão: visitante vê Entrar/Cadastrar; autenticado vê o restante', async () => {
    await signInTo(loginAs(['PARTICIPANT']), '/inicio');
    await screen.findByRole('heading', { name: 'Início' });
    const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
    for (const name of ['Eventos', 'Início', 'Minhas inscrições', 'Meu perfil', 'Sair']) {
      expect(nav).toHaveTextContent(name);
    }
    expect(nav).not.toHaveTextContent('Entrar');
  });
});
