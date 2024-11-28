export const EnvConfiguration = () => ({
    environment: process.env.NODE_ENV || 'dev',
    mongodb: process.env.MONGODB,
    port: process.env.PORT || 3001,
    defaultLimit: +process.env.DEFAULT_LIMIT || 8,
})
// este archivo se overidea por el joi.validation.ts
// es de una libreria que permite mas validaciones en caso de faltar alguna key del env
// y se toman directamente como la variable faltante, no el valor sustituyente 