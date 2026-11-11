# Comunicación de la aplicación Pokémon

MySQL autentica y administra usuarios; Nest verifica su identidad actual y
comunica las instancias React por Socket.IO. `/mensajes-prueba` permite elegir
cualquier otro usuario registrado y conversar en privado. No hay una lista fija
de dos correos. Esta etapa no incorpora sincronización de batallas.

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
