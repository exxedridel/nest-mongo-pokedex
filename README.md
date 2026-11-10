# Comunicación de la aplicación Pokémon

MySQL autentica y administra usuarios; Nest verifica su identidad actual y
comunica las instancias React por Socket.IO. `/mensajes-prueba` permite elegir
cualquier otro usuario registrado y conversar en privado. No hay una lista fija
de dos correos. Esta etapa no incorpora sincronización de batallas.

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
