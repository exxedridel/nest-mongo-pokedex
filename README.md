<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

# POKEDEX API
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


