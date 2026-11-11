# Contexto de la trilogia Pokemon

Acuerdo del usuario confirmado el 2026-11-08:

- `mysql-restapi` gestiona autenticacion e identidad mediante JWT.
- `nest-mongo-pokedex` comunica las instancias del frontend mediante WebSocket.
- `vite-react-railway` contiene las vistas de jugadores y administrador; las batallas se llevan a cabo en el panel administrador.
- Los tres proyectos forman una sola aplicacion y se deben usar conjuntamente.

Si esta disponible, leer [la memoria compartida](../PROJECT_MEMORY.md). Este resumen se conserva tambien aqui para sesiones que abran solo este repositorio.

Trainer Battle autorizado 2026-11-11 amplía /pvp: mode:'trainer', preset Kanto
servidor, players sólo a humano y trainer descriptor+team (team sólo admin).
create acepta playerAId+trainerPresetId exclusivamente de playerBId. Reserva/
resultado/ACK únicamente A; applied.b=true. Mantener pausa con humano original
y epoch/CAS. IA AUTOMÁTICA y motor siguen en React admin, no Nest. Catálogo
18 presets/68 slots exactos JSON copiado a dist via nest-cli asset. NPC escala
HP al snapshot A y no modifica stats/roster/moves. Recharge move0 locked/PP0
soportado, Struggle165 pp0/maxpp0 listado permitido; no saltar turnos con wait.
30 tests/build aprobados; desplegar Nest
y React sin variables nuevas. Ver memoria/protocolo para UI y validación Chrome.

Evaluar Nest como servicio de comunicacion en tiempo real. No concluir que sobra
porque su catalogo HTTP no se consuma. El motor permanece en el panel admin.
El alcance futuro confirmado son batallas PvP por instantaneas y resultados;
persistir toda la partida en Nest no es un requisito. PvP local ya implementado:
PvpModule /pvp guarda SOLO documentos batalla en pvp_battles, reservas con indices
unicos/CAS, checkpoints del motor admin, comandos y resultados pendientes. ADMIN
controla ambos lados; jugador solo snapshot/vista propia/applied. No desbloquear
por desconexion/timeout; liberar tras ambos guardados. Epoch cerca host antiguo.
Buffer compartido Socket.IO 4MiB, validadores separados: chat texto1000chars,
checkpoint2MiB/documento4MiB. Una replica. Ver README/PVP_PROTOCOL de workspace.
Correccion 2026-11-11: mantener minimize:false en schema PvP; objetos vacios
Mixed como runtime.pending son datos del protocolo, no campos prescindibles.
Lecturas recuperan mapas legacy conocidos; snapshots solo con hash original
exacto. No reconstruir motor/requests ni liberar reservas. test:pvp incluye
regresion con Mongoose real y driver simulado; Mongo/indices reales pendientes.

No guardar credenciales o tokens en la documentacion. Actualizar el contexto cuando el usuario confirme nuevos acuerdos.

El modulo `messages` y `npm run test:messages` existen desde 2026-11-09.
La etapa 2026-11-10 elimina la lista fija de correos: salas por ID de usuario,
JWT y verificacion vigente mediante MySQL. Requiere la nueva `AUTH_API_URL` antes
del deploy; MySQL debe publicar primero `/api/auth/me` y `/api/users/contacts`.
Una replica y sin historial persistente. Ver README; despliegue nuevo pendiente.
