import { useNavigate } from 'react-router';
import { EventFormFields } from '../components/organizer';
import { usePageTitle } from '../components/usePageTitle';
import { toEventInput } from '../schemas/organizer';
import { useServices } from '../services/ServicesContext';

/** Cria o evento como rascunho; depois leva à página de gestão, onde se adicionam atividades e se publica. */
export function NewEventPage() {
  usePageTitle('Novo evento');
  const { eventsApi } = useServices();
  const navigate = useNavigate();
  return (
    <section className="card">
      <h1>Novo evento</h1>
      <p className="lead">
        O evento nasce como rascunho. Adicione atividades e publique em seguida.
      </p>
      <EventFormFields
        submitLabel="Criar evento"
        loadingText="Criando…"
        onSubmit={async (values) => {
          const created = await eventsApi.createEvent(toEventInput(values));
          void navigate(`/organizador/eventos/${created.event_id}`, { replace: true });
        }}
      />
    </section>
  );
}
