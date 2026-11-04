import { describe, expect, it } from 'vitest';
import { API_PATHS, ConfigError, readConfig } from './config';

describe('readConfig', () => {
  it('usa a URL do Gateway configurada, sem barra final', () => {
    expect(readConfig({ VITE_API_BASE_URL: 'https://gateway.example.com/' }).apiBaseUrl).toBe(
      'https://gateway.example.com',
    );
    expect(readConfig({ VITE_API_BASE_URL: ' http://gw.test:8080 ' }).apiBaseUrl).toBe(
      'http://gw.test:8080',
    );
  });

  it('preserva um prefixo de caminho do Gateway', () => {
    expect(readConfig({ VITE_API_BASE_URL: 'https://example.com/api/' }).apiBaseUrl).toBe(
      'https://example.com/api',
    );
  });

  it('falha de forma clara quando ausente, inválida ou com protocolo inesperado', () => {
    expect(() => readConfig({})).toThrow(ConfigError);
    expect(() => readConfig({ VITE_API_BASE_URL: '   ' })).toThrow(/VITE_API_BASE_URL/);
    expect(() => readConfig({ VITE_API_BASE_URL: 'gateway' })).toThrow(/absoluta/);
    expect(() => readConfig({ VITE_API_BASE_URL: 'ftp://gateway' })).toThrow(/http/);
  });

  it('mantém os caminhos das APIs em um único lugar', () => {
    expect(API_PATHS.users).toBe('/user/api/v1');
  });
});
