# Contexto de la trilogia Pokemon

Acuerdo del usuario confirmado el 2026-11-08:

- `mysql-restapi` gestiona autenticacion e identidad mediante JWT.
- `nest-mongo-pokedex` comunica las instancias del frontend mediante WebSocket.
- `vite-react-railway` contiene las vistas de jugadores y administrador; las batallas se llevan a cabo en el panel administrador.
- Los tres proyectos forman una sola aplicacion y se deben usar conjuntamente.

Si esta disponible, leer [la memoria compartida](../PROJECT_MEMORY.md). Este resumen se conserva tambien aqui para sesiones que abran solo este repositorio.

Etapa vigente2026-11-12 React2.5.0: TM consumible500, sólo uso local fuera de
combate. USABLE_ITEM_IDS/UsableItemId añade tm a ItemUse y parser shop:use/
use-cancel; exige moveId1..354, contextparty y owner.localBattle=false antesCAS.
Debita1 con recibo durable, stock0/replay/cancel y planHash exacto. No nuevo DTO
replacement: hashplan enlaza efecto frontend. HashFullRestore/Ether/Elixir
intactos. CONSUMABLE_ITEM_IDS mantiene3: TM rechazada en validateChoice,
consumeBattleItem y stock de batalla. User conserva2inicialesgratis y reemplazo
por1TM con4 en frontend. 74Shop/47PvP/29chat/build pasan; dist estable para QA.
Chrome TM completo y flujos anteriores aprobados, ver memoria. Desplegar Nest luego React, sin variables/
MySQL/schema/seed ni borrar reservas/partidas.

Etapa anterior2026-11-12 React2.4.0: PP persistentes y Max Ether350/Max Elixir700.
Usuario confirmó PP entre batallas/reloads; missing/new a máximo, Struggle con
todos0, continuaciones/recarga sin gasto adicional. Ether selecciona movimiento,
Elixir todos del Pokémon; admite KO y no gasta con PP completos. Motor/IA siguen
en React; Nest sólo valida/persiste y coordina inventario. currentPp opcional
en snapshot se valida0..máximo de pp catálogo o JSONGenIII compartido con React;
copiar asset a dist. pp catálogo sigue inmutable. Primer checkpoint conserva PP
original; staticCapture ignora sólo currentPp. Result.movesPp opcional enlaza IDs
originales exactos; resultados legacy sin PP conservan su forma/hashes.
Shop catálogo y use/cancel soportan3 consumibles, moveId sólo Ether; omisión
itemId sigue Full Restore. Su requestHash antiguo se conserva literalmente.
Battle.itemInventory por lado/tipo mantiene inventory numérico Full Restore.
Grants/itemCommands/outbox/battleUses vinculan itemId/moveId y conservan clave
batalla/comando; outbox previo al débito recupera sin consumo duplicado incluso
desde documentos legacy. No normalizar snapshots/planes antes de validar hashes.
63 Shop/47 PvP/29 chat y build pasan;14 motor/6 legacy/9 Party/15 wallet frontend
aprobadas. Suite combinada152, TS y build React correctos. Chrome2.4.0 Tienda/
PP/wild/Trainer/JcJ/reconexión pasa, incluidos stock/PP tras resultado y reload.
Producción no verificada. Desplegar Nest luego React,
sin variables nuevas/MySQL/seed ni borrar reservas. Ver memoria compartida.

Etapa anterior: Full Restore con stock Bag autorizado 2026-11-12 con React2.3.0. ShopService
use/use-applied/use-cancel debita1+pending en CAS, contexto party/local-battle,
planHash y sesión/client/revisión; cancelación persistente. Sin motor/Party en
servidor. Admin PvP permite item autorizado con stock humano. Battle.inventory/
itemCommands reservan presupuesto; session.networkItems.used indica ejecución.
pendingInventoryCheckpoint se guarda antes del débito entre documentos;
wallet.battleUses deduplica batalla/comando y sync completa el checkpoint.
Cancelar/forfeit antes del efecto no cobra. Campos opcionales legacy; mantener
minimize:false. ShopModule global comparte providers sin inyectar PvP en Shop;
Shop es opcional en PvpService para tests legacy sin items. 48 Shop/35 PvP/29 chat
y build correctos. Chrome compra/dashboard/wild/Trainer/Storage/reload pasa.
Sin MySQL/env/seed ni borrado de reservas. Desplegar Nest luego React.

Economía Poké Mart /shop persiste wallets+recibos, partida general sigue local.
Corrección autorizada2026-11-12: shop:reset del propio jugador establece500 y
items{} enCAS, GameReset pending. Excluye batallas/compras con ActivityService;
revalida cuenta/socket antes CAS. ACK shop:reset-applied sólo navegador original
tras guardar Party; pending bloquea nuevascompras y reservas aunque desconecte.
shop:reset-cancel persiste cancelled si no hubo commit; copias tardías no pueden
ejecutar. No libera/borra pending real. Reset ledger conserva idempotencia,
compras e historial; campo resets opcional compatible con carteras anteriores.
Admin sólo lee: no inicia resets. Userconfirma deploy2.2.0; esta correcciónlocal
requiere desplegar Nest luego React2.2.1, sin nuevasvariables/MySQL/seed.

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
