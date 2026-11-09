# Contexto de la trilogia Pokemon

Acuerdo del usuario confirmado el 2026-11-08:

- `mysql-restapi` gestiona autenticacion e identidad mediante JWT.
- `nest-mongo-pokedex` comunica las instancias del frontend mediante WebSocket.
- `vite-react-railway` contiene las vistas de jugadores y administrador; las batallas se llevan a cabo en el panel administrador.
- Los tres proyectos forman una sola aplicacion y se deben usar conjuntamente.

Si esta disponible, leer [la memoria compartida](../PROJECT_MEMORY.md). Este resumen se conserva tambien aqui para sesiones que abran solo este repositorio.

Evaluar Nest como servicio de comunicacion en tiempo real. No concluir que sobra porque su catalogo HTTP no se consuma actualmente. El analisis propone que autentique conexiones, gestione salas, ordene mensajes, persista estados y distribuya vistas privadas, conservando el simulador en el panel administrador. Estas funciones son propuestas pendientes de implementacion, no funcionalidades existentes ni nuevos requisitos confirmados.

No guardar credenciales o tokens en la documentacion. Actualizar el contexto cuando el usuario confirme nuevos acuerdos.

Primera integracion local (2026-11-09): ya existe el modulo `messages`, con Socket.IO autenticado para `/mensajes-prueba`, y `npm run test:messages`. Se limita a las dos cuentas indicadas en `messages.types.ts`, una replica y sin historial persistente. La sincronizacion de batallas sigue pendiente. Ver README.
