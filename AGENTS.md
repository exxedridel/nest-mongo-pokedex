# Contexto de la trilogia Pokemon

Acuerdo del usuario confirmado el 2026-11-08:

- `mysql-restapi` gestiona autenticacion e identidad mediante JWT.
- `nest-mongo-pokedex` comunica las instancias del frontend mediante WebSocket.
- `vite-react-railway` contiene las vistas de jugadores y administrador; las batallas se llevan a cabo en el panel administrador.
- Los tres proyectos forman una sola aplicacion y se deben usar conjuntamente.

Si esta disponible, leer [la memoria compartida](../PROJECT_MEMORY.md). Este resumen se conserva tambien aqui para sesiones que abran solo este repositorio.

Evaluar Nest como servicio de comunicacion en tiempo real. No concluir que sobra
porque su catalogo HTTP no se consuma. El motor permanece en el panel admin.
El alcance futuro confirmado son batallas PvP por instantaneas y resultados;
persistir toda la partida en Nest no es un requisito. Batallas siguen pendientes.

No guardar credenciales o tokens en la documentacion. Actualizar el contexto cuando el usuario confirme nuevos acuerdos.

El modulo `messages` y `npm run test:messages` existen desde 2026-11-09.
La etapa 2026-11-10 elimina la lista fija de correos: salas por ID de usuario,
JWT y verificacion vigente mediante MySQL. Requiere la nueva `AUTH_API_URL` antes
del deploy; MySQL debe publicar primero `/api/auth/me` y `/api/users/contacts`.
Una replica y sin historial persistente. Ver README; despliegue nuevo pendiente.
