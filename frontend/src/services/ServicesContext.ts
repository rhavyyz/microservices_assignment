import { createContext, useContext } from 'react';
import type { Services } from './createServices';

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services)
    throw new Error('useServices deve ser usado dentro de <ServicesContext.Provider>.');
  return services;
}
