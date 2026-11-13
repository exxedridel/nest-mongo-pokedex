# Comunicación de la aplicación Pokémon

MySQL autentica y administra usuarios; Nest verifica su identidad actual y
comunica las instancias React por Socket.IO. `/mensajes-prueba` permite elegir
cualquier otro usuario registrado y conversar en privado. No hay una lista fija
de dos correos. Las batallas y la Tienda usan los namespaces descritos abajo.

## Pokedollars y Poké Mart: namespace `/shop`

Nest conserva el saldo y las cantidades compradas en `shop_wallets`, separado
del guardado general de la Party. Cada cuenta de jugador recibe **500 Pokedollars
una sola vez**, al crear su wallet con `currencyVersion: 1`. El frontend adopta
ese saldo y reemplaza el dinero local anterior, según la decisión del usuario.
Reconectar o cerrar sesión conserva el saldo. Desde React2.2.1, el reinicio
explícito de partida del jugador sí establece500 y vacía los objetos comprados.

La Tienda obtiene automáticamente las cuentas de jugador conectadas a `/shop`.
Sólo una cuenta admin vigente puede comprar. El servidor decide el precio a
partir del catálogo; rechaza saldos/precios enviados por el cliente, cantidades
fuera de 1–99, fondos insuficientes y revisiones antiguas. Comprar guarda saldo,
cantidades y recibo en **una única escritura CAS** con journaling. Full Restore,
Max Ether, Max Elixir y TM se consumen; el resto conserva cantidades para uso posterior.
Max Ether cuesta350 Pokedollars y Max Elixir700; Nest fija esos precios.

Antes de cobrar, `shop:prepare` solicita al navegador seleccionado que confirme
que está fuera de batalla y guarde una reserva local. El ACK tiene cinco segundos
de plazo. Tras esa reserva se revalidan identidad, rol y conexión original antes
del CAS. Una cola compartida con PvP evita iniciar una batalla durante la compra;
también se comprueban las reservas persistidas de PvP/Trainer y el estado PvE local.

Una compra persistida queda `pending` hasta que ese navegador guarde la wallet
y responda `shop:applied`. El resultado se recupera tras desconexión o reinicio;
no se devuelve el dinero ni se repite el descuento por un timeout. Reenviar el
mismo `requestId` del mismo admin devuelve la operación anterior, y cambiar su
contenido se rechaza. Se conservan hasta 4096 compras por wallet sin descartar
claves de idempotencia; alcanzado el límite se rechazan nuevas compras antes
de cobrar. Las vistas de historial muestran las últimas 50.

El cliente no libera una reserva sólo porque un evento o una caché carezca de
recibo. Puede liberarla con un recibo `applied` coincidente o tras un
`shop:sync` explícito emitido después de PREPARE: esa lectura pasa por la misma
cola y actúa como barrera para confirmar que la compra se abortó. No se debe
esperar esa lectura antes de devolver el ACK de PREPARE.

### Reinicio de partida

`shop:reset {requestId,expectedWalletRevision}` sólo acepta al jugador de la
sesión actual. Verifica identidad, propietario, revisión y ausencia de batalla
o compra pendiente usando la misma cola compartida. Una escritura CAS guarda
saldo500, `items:{}`, revisión incrementada y recibo de reinicio `pending`.
No borra compras, recibos ni batallas. `resets` es opcional en wallets anteriores;
el schema preserva los objetos vacíos y no necesita seed ni migración destructiva.

El navegador conserva una solicitud local antes de enviarla, reinicia su Party
una sola vez mediante guardado comprobado y confirma con
`shop:reset-applied {requestId,revision}`. Hasta entonces se rechazan compras y
reservas PvP/Trainer. Los estados de reinicio pendientes se publican a los otros
navegadores de esa cuenta para que vuelvan al propietario original.

`shop:reset-cancel {requestId,expectedWalletRevision}` persiste un recibo
`cancelled` si la operación aún no se realizó. Si ya existe `pending/applied`,
devuelve ese mismo resultado: cancelar no revierte un reinicio confirmado.
La cancelación impide ejecutar después una copia retrasada de la solicitud.
Reintentar el mismo ID nunca repone fondos ni vuelve a borrar la partida.

### Uso de Full Restore, Max Ether, Max Elixir y TM

`shop:use {requestId,captureId,context,planHash,expectedWalletRevision}` consume
una unidad de la Bag del propio jugador, con contexto `party` o `local-battle`.
Exige sesión/navegador vigentes, revisión exacta, existencias y ausencia de otra
operación o batalla reservada. Persiste wallet y recibo `pending` en un CAS.
`shop:use-applied {requestId,revision}` confirma que el dispositivo guardó el plan;
`shop:use-cancel` recibe el payload original y persiste `cancelled` si todavía
no se consumió. Los pendientes bloquean compras, reinicios y reservas de batalla.

`itemId` opcional admite `full-restore`, `max-ether`, `max-elixir` o `tm`; omitirlo
conserva el contrato anterior de Full Restore. `moveId` es obligatorio sólo
para Max Ether y TM. Recibos y reintentos vinculan objeto, objetivo, movimiento y
plan; cambiar esos datos con el mismo ID produce conflicto. La huella de los
recibos Full Restore anteriores permanece idéntica. El efecto y la validación
de que faltan PP se preparan en React, que guarda antes de confirmar el débito.

TM conserva su precio500 y sólo admite contexto `party`, con el jugador fuera
de batalla. El frontend valida compatibilidad/espacios y prepara el movimiento
o sustitución; `planHash` vincula ese resultado exacto al recibo. Nest consume1
TM, sin modificar la Party ni calcular movimientos. `USABLE_ITEM_IDS` añade TM
al flujo local; `CONSUMABLE_ITEM_IDS` permanece limitado a los tres objetos de
batalla. TM se rechaza en comandos y débitos de combate. Las dos elecciones
iniciales gratuitas son locales y no usan este recibo.

En `/pvp`, sólo se aceptan elecciones item de los humanos con stock. Elegirlo
reserva la acción sin descontar la unidad. El adaptador admin registra el comando
cuando se ejecuta el evento nativo; el checkpoint identifica esos comandos en
`networkItems.used`. Nest valida su pertenencia y persiste un checkpoint pendiente
antes de debitar cada wallet por clave batalla/comando. Al terminar el débito
confirma el checkpoint. Sync reanuda ese registro tras fallos, sin doble consumo.
Cancelar o terminar por rendición antes de ejecutar el objeto no consume.

La vista admin conserva `inventory` numérico por lado para Full Restore y añade
`itemInventory` con cantidades por lado y tipo de objeto. Comandos y outbox
vinculan también `itemId`/`moveId`; sus campos opcionales conservan compatibilidad.
Las instantáneas admiten `moves[].currentPp` y los resultados `movesPp` con el
mapa exacto de movimientos aprendidos. `pp` sigue siendo el máximo del catálogo.
PP0 y hashes originales se conservan; una reserva antigua no se normaliza ni se
borra. El asset Gen III `movePpData.json` viaja al build como respaldo de máximos.

Los campos nuevos son opcionales para wallets/batallas anteriores. No ejecutar
seed ni borrar reservas. El motor, HP y RNG siguen calculándose en React.

La presencia y la exclusión entre namespaces requieren **una sola réplica Nest**.
Desplegar **Nest primero y React después**, conservando las variables existentes.
No cambia MySQL ni requiere nuevas variables. Mongo necesita permisos para crear
la colección e índices; no ejecutar el seed. Contrato completo en
[`../SHOP_PROTOCOL.md`](../SHOP_PROTOCOL.md) dentro del workspace.

```bash
npm run test:shop
```

Las pruebas de Shop usan sockets reales y repositorios simulados, incluida
serialización Mongoose con un driver simulado. Cubren autoridad, importes,
idempotencia, preflight, carreras con batallas, fallos de guardado y reconexión.
La colección e índices de Mongo reales se deben comprobar al desplegar.

## Batallas PvP: namespace `/pvp`

El administrador selecciona dos jugadores disponibles y maneja ambos equipos
en React. Nest reserva sus identidades, recibe snapshots de 1–6 Pokémon y
conserva el último checkpoint del motor y los resultados pendientes en Mongo.
No calcula el combate ni reemplaza el guardado general de los jugadores.

### Trainer Battle

El mismo namespace soporta un humano A contra un NPC B. `pvp:create` recibe
`{commandId,playerAId,trainerPresetId}` y reserva sólo al jugador A; no admite
simultáneamente `playerBId`. Los 18 presets de Kanto (ocho líderes, cuatro Alto
Mando y seis variantes del rival) se validan contra `pvp/kantoPresets.json`.
El asset se copia a `dist` al compilar; no necesita API externa ni variables nuevas.

Cuando llega el snapshot A, el NPC se prepara con su preset completo y el
multiplicador de HP del propietario. La sesión mantiene dos equipos, pero
`players` sólo contiene `a`. La IA y el motor se ejecutan en React administrador;
Nest valida y persiste comandos/checkpoints. Sigue exigiendo conexión del jugador
original y el anfitrión vigente para avanzar.

Sólo A recibe un resultado. `applied.b` comienza en true porque el NPC no guarda
partida; el documento se libera después del ACK de A. El jugador recibe el
descriptor del Trainer sin su equipo completo ni el motor. Las reservas impiden
que esa misma cuenta participe a la vez en PvP y Trainer Battle.
Los checkpoints conservan especie, nivel, stats base y movimientos del preset.
Se admite la solicitud nativa forzada Recharge (movimiento 0, PP 0), utilizada
por Hyper Beam; no se permite omitir turnos con `wait`.

`PvpModule.forMongo()` crea `pvp_battles` e índices únicos parciales para impedir
que un jugador o administrador figure en dos batallas reservadas. Los índices
deben estar disponibles antes de aceptar operaciones. Las reservas de ambos
jugadores viven en un documento y se actualizan mediante revisión/CAS; no se
requieren transacciones Mongo entre documentos. Las escrituras se confirman
después de guardar con journaling. No hay TTL que elimine batallas pendientes.

El schema conserva los objetos vacíos (`minimize: false`): `runtime.pending: {}`
significa que aún no se eligieron acciones. Eliminarlos provocaba un fallo al
abrir los controles del administrador. Las lecturas recuperan esos mapas en
documentos anteriores; los campos opcionales de snapshots solo se restauran si
coinciden con su hash original. Las reservas y el motor no se reinician.

Fases: `collecting → ready → active → finished → finalizing → finalized`.
Solo collecting/ready pueden cancelarse. Los locks se liberan al cancelar o
después de que ambos propietarios confirmen el guardado del resultado final.
La desconexión, caducidad del JWT o reinicio no liberan las reservas. Se exige
reconectar al propietario original; las discrepancias conservan el bloqueo.

La autenticación reutiliza MySQL `/api/auth/me`. Cada operación y publicación
revalida la identidad vigente. Solo el anfitrión admin puede encolar movimientos,
cambios o rendición; los jugadores solo presentan su snapshot, observan su vista
privada y confirman resultados. Un epoch de anfitrión y una revisión propia del
checkpoint evitan escrituras antiguas. Los comandos se identifican y se guardan
antes de confirmar su recepción; esa confirmación no equivale a su aplicación.

El resultado individual limita cambios a HP y estados/contadores finales de las
capturas originales. No entrega engine, equipo completo o decisiones pendientes
del rival. Se guarda localmente junto con el recibo de resultado antes del ACK;
los reintentos no deben volver a aplicar el cambio. Mongo conserva la entrega
pendiente si el jugador se desconecta después de terminar el combate.

El namespace usa el mismo puerto, origen y `/socket.io/` del chat. Como Nest
comparte el servidor de transporte entre namespaces, el buffer de transporte
es 4 MiB; los validadores mantienen el límite de texto del chat en 1000
caracteres, checkpoint en 2 MiB y documento PvP en 4 MiB. La presencia se mantiene
en el proceso: **una sola réplica Nest** en esta etapa. Un socket polling de un
documento abandonado puede tardar hasta heartbeat en desaparecer de presencia;
la sesión se revalida antes de operar o distribuir datos privados.

Desplegar esta versión de Nest antes del frontend. Se usan las variables
existentes; Mongo necesita permisos de colección e índices. No ejecutar el seed.
El detalle de eventos y DTO compartido está en `../PVP_PROTOCOL.md` dentro del
workspace. Cada repositorio conserva los tipos necesarios para su despliegue.

```bash
npm run test:pvp
```

Las pruebas usan un repositorio Memory y sockets reales: cubren reservas
concurrentes, CAS/reinicio, privacidad, host antiguo, turnos, deduplicación,
resultado inmutable y liberación posterior a ambos ACK. `PvpModule.withRepository`
y `MemoryPvpRepository` permiten QA aislado sin iniciar Mongo. La colección y los
índices reales deben comprobarse después en el entorno desplegado. También
ejecutan MongoPvpRepository con Mongoose real y una colección simulada para
comprobar la serialización de insert/replaceOne y recuperación de registros
anteriores; esta comprobación no requiere un servidor Mongo.

## Configurar antes de desplegar en Railway

- `JWT_SECRET`: exactamente el mismo valor privado utilizado en `mysql-restapi`.
  Es obligatorio; `SECRET_KEY` y `JWT_SEED` no lo sustituyen. Nunca compartirlo
  con React.
- `AUTH_API_URL`: origen del servicio MySQL, sin `/api` ni otras rutas, por
  ejemplo `https://mysql-restapi-production-5f4b.up.railway.app`. **Añadir esta
  variable antes de desplegar la nueva versión de Nest.** Nest consulta
  `GET /api/auth/me` y `GET /api/users/contacts` enviando el JWT por Bearer.
  El servicio MySQL debe desplegar primero esos endpoints.
- `FRONTEND_ORIGINS`: orígenes adicionales separados por comas y sin rutas.
  Ya se permiten `http://localhost:5173` y `https://mern-app.up.railway.app`.
  El listado se aplica a HTTP y Socket.IO.
- Mantener `MONGODB` y las variables existentes. Esta mensajería no crea
  colecciones ni requiere ejecutar el seed. Railway proporciona `PORT`.

Instalar con `npm ci`, compilar con `npm run build` e iniciar con
`npm run start:prod`.

La conexión requiere un JWT HS256 válido con `id`, `email` y `exp`, y una cuenta
vigente confirmada por MySQL. La versión del token, eliminación de cuentas y
cambios de contraseña/correo/rol los valida MySQL. Los JWT anteriores sin versión
solo sirven mientras el servidor de identidad acepte su versión inicial cero.
Nest comprueba también que ID y correo del JWT coincidan con el perfil obtenido;
no reconstruye identidades si MySQL falla.

Cada envío vuelve a consultar la identidad del emisor y el directorio. Las otras
pestañas que van a recibir el mensaje también se revalidan antes de recibir datos
privados. Una sesión revocada se desconecta; esto no es una notificación instantánea
al editar cuentas: se detecta en la siguiente operación/comprobación. La caducidad
del JWT además desconecta el socket mediante un temporizador. Las peticiones de
identidad tienen timeout de tres segundos y no siguen redirecciones. Una caída
temporal devuelve `AUTH_UNAVAILABLE`; no se confunde con una sesión revocada.

## Protocolo de mensajes

Conexión: `io("https://tu-nest.up.railway.app/mensajes-prueba", { auth: { token } })`.
El transporte usa `/socket.io/` y el puerto HTTP existente. No añadir `/api/v2`
al namespace.

`UserPublic` contiene `{ id, email, first_name, last_name, role }`, con rol
`player` o `admin`. Los contactos añaden `online`.

| Evento                                   | Datos                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Cliente → `mensajes:enviar`              | `{ clientMessageId, text, toUserId }`, con ACK por callback.                        |
| Cliente → `mensajes:contactos:solicitar` | Sin datos; refresca el directorio y devuelve `{ ok: true, users }` o un error.      |
| Servidor → `mensajes:recibir`            | `{ id, clientMessageId, from, to, fromUserId, toUserId, text, sentAt }`.            |
| Servidor → `mensajes:estado`             | `{ selfEmail, selfUserId }`.                                                        |
| Servidor → `mensajes:contactos`          | `{ users: [...UserPublic con online] }`; directorio inicial/refrescado y presencia. |
| Servidor → `mensajes:error`              | `{ code, message }`. El rechazo inicial también llega en `connect_error.data`.      |

El ACK de envío es `{ ok: true, message }` o
`{ ok: false, error: { code, message } }`. El servidor determina el remitente
desde la identidad verificada; solo admite los tres campos de envío indicados,
texto de 1 a 1000 caracteres y un destino entero existente. Las salas internas
usan ID estable, no correo. Solo reciben el emisor, destinatario y sus pestañas
con sesiones vigentes; otro usuario conectado no recibe esa conversación.

El `clientMessageId` admite 1 a 128 caracteres alfanuméricos y `_.:-`.
Un reintento del mismo usuario con igual identificador, texto y destino devuelve
el mensaje anterior sin volver a emitirlo. Reutilizarlo con otro texto o destino
devuelve `MESSAGE_ID_CONFLICT`. La deduplicación dura hasta quince minutos y
tiene un máximo de mil entradas en memoria.

La confirmación indica aceptación en Nest, no lectura ni entrega a un usuario
desconectado. No hay historial persistente ni entrega posterior. Utilizar una
sola instancia/réplica Nest: presencia y deduplicación son locales al proceso.
Los mensajes de la interfaz se pierden al salir o recargar. El directorio se
refresca mediante `mensajes:contactos:solicitar`; no hay suscripción a cambios
del CRUD MySQL. La selección de un contacto la mantiene cada navegador.

## Prueba automatizada local

```bash
npm run test:messages
```

La suite usa un módulo Nest aislado, clientes Socket.IO reales y un servidor HTTP
de identidad simulado en puertos locales efímeros. Cubre nuevas cuentas,
privacidad por ID, sesiones revocadas, expiración, errores/timeout de identidad,
deduplicación y presencia con varias pestañas. No usa bases de datos,
credenciales reales ni los servicios de Railway.

Para comprobar la aplicación completa, desplegar primero MySQL, después Nest con
las variables anteriores y finalmente React; iniciar sesión con dos usuarios
registrados en perfiles o dispositivos diferentes, abrir `/mensajes-prueba`,
elegir al otro contacto y enviar mensajes en ambos sentidos. Las pestañas del
mismo perfil comparten el login guardado en `localStorage`.

## Ejemplo original de catálogo

El proyecto conserva el ejemplo NestJS/TypeScript con MongoDB y sus rutas HTTP
bajo `/api/v2`. Para desarrollo: instalar dependencias, copiar `.env.template`
a `.env`, configurar las variables requeridas, iniciar MongoDB con
`docker-compose up -d` y ejecutar `npm run start:dev`.

La ruta original `GET /api/v2/seed` reconstruye destructivamente el catálogo de
ejemplo; no participa en usuarios o mensajes y no debe ejecutarse para esta
integración.
