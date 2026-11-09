<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

# POKEDEX API

## Mensajes de prueba entre jugador y administrador

Primera integración de los tres proyectos: MySQL autentica, Nest comunica por
Socket.IO y React presenta `/mensajes-prueba`. Participan únicamente
`hevedrios@gmail.com` y `najerad2223@gmail.com`. El remitente se obtiene del JWT
verificado; el destinatario es siempre la otra cuenta.

### Configurar antes de desplegar en Railway

- `JWT_SECRET`: exactamente el mismo valor privado utilizado en `mysql-restapi`.
  Es obligatorio para arrancar Nest. `SECRET_KEY` y `JWT_SEED` no sustituyen esta
  variable. Nunca se comparte el secreto con React.
- `FRONTEND_ORIGINS`: orígenes adicionales separados por comas, sin rutas; por
  ejemplo `https://tu-frontend.up.railway.app,http://localhost:5173`.
  Ya están permitidos `http://localhost:5173` y
  `https://mern-app.up.railway.app`. El mismo listado se aplica a HTTP y Socket.IO.
- Mantener `MONGODB` y las variables existentes: esta prueba no necesita crear
  colecciones ni ejecutar el seed. Railway proporciona `PORT`.

Instalar con `npm ci` y compilar con `npm run build`. El servicio se inicia con
el comando de producción existente, `npm run start:prod`.

El namespace es `/mensajes-prueba`, con transporte en `/socket.io/` sobre el mismo
puerto HTTP. El prefijo HTTP `/api/v2` no se añade al namespace.

### Protocolo mínimo

Conexión: `io("https://tu-nest.up.railway.app/mensajes-prueba", { auth: { token } })`.

| Evento | Datos |
| --- | --- |
| Cliente → `mensajes:enviar` | `{ clientMessageId, text }`, con confirmación por callback. |
| Servidor → `mensajes:recibir` | `{ id, clientMessageId, from, to, text, sentAt }`. |
| Servidor → `mensajes:estado` | `{ selfEmail, peerEmail, peerOnline }`. |
| Servidor → `mensajes:error` | `{ code, message }`, por ejemplo al caducar la sesión. |

Confirmación: `{ ok: true, message }` o `{ ok: false, error: { code, message } }`.
Solo se admiten `clientMessageId` y `text`, de hasta 1000 caracteres. Un reintento
con el mismo identificador y texto devuelve la confirmación anterior sin volver
a emitirlo. La deduplicación dura hasta 15 minutos y tiene un límite de 1000
entradas en memoria.

La confirmación indica aceptación en Nest, no lectura ni entrega a un usuario
desconectado. No hay historial persistente ni entrega posterior. Usar **una sola
instancia/réplica Nest** para esta prueba: presencia y deduplicación son locales
al proceso. Los mensajes del navegador se pierden al salir o recargar.

### Prueba automatizada local

```bash
npm run test:messages
```

La suite inicia el módulo de mensajes en un puerto efímero y conecta clientes
Socket.IO reales. Usa JWT firmados exclusivamente para pruebas con el contrato
del login MySQL. No consulta la base de datos ni usa credenciales de Railway.

### Comprobar desde los dos usuarios

1. Desplegar Nest con las variables anteriores y el frontend actualizado.
2. Entrar como `hevedrios@gmail.com` y abrir `/mensajes-prueba`.
3. En una ventana privada, otro perfil o dispositivo, entrar como
   `najerad2223@gmail.com` y abrir la misma ruta.
4. Esperar que ambas páginas indiquen conexión y destinatario conectado.
5. Enviar mensajes en ambos sentidos. Al cerrar una página, la otra debe indicar
   que el destinatario está desconectado.

Se necesitan ventanas privadas/perfiles diferentes porque el login actual usa
`localStorage` compartido entre pestañas del mismo perfil.

## Ejemplo original de catálogo

## Stack usado
* Nest.js (TypeScript)
* MongoDB

## Ejecutar en desarrollo

1. Clonar el repositorio
2. Ejecutar
```
npm install
```
3. Tener Nest CLI instalado
```
npm i -g @nest/cli
```
4. Levantar la base de datos
```
docker-compose up -d
```
5. Clonar el archivo ```.env.template``` y renombrar la copia a ```.env```
6. Correr el proyecto, ejecutar
```
npm run start:dev
```
7. Reconstruir la base de datos con la semilla
```
GET http://localhost:3000/api/v2/seed
```
## Ejecutar en producción (sin Docker)
1. Copiar las variables de entorno del ```.env``` en la configuración del Host destino
2. Reemplazar el valor de la variable __MONGODB__ por la URI proporcionada por el HOST dentro de su configuración
3. Ejecutar
```
npm run build
```
4. Mandar push al repositorio remoto y correr el deploy en el Host destino


