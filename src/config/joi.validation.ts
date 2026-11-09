import * as Joi from 'joi';

export const JoiValidationSchema = Joi.object({
    MONGODB: Joi.required(),
    PORT: Joi.number().default(3005),
    DEFAULT_LIMIT: Joi.number().default(6),
    JWT_SECRET: Joi.string().pattern(/\S/).required(),
    FRONTEND_ORIGINS: Joi.string().allow('').optional(),
})
