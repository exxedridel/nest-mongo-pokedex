// Entidades hacen una relación con las tablas de la Base de Datos
// Cada instancia de una clase hace un registro a la base de datos
// En dases no SQL las instancias se conocen como colecciones y documentos

import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";


@Schema()
export class Pokemon extends Document {

    // id: string // Mongo ya lo da

    @Prop({
        unique: true,
        index: true,
    })
    name: string;

    @Prop({
        unique: true,
        index: true,
    })
    no: number
}

export const PokemonSchema = SchemaFactory.createForClass(Pokemon)
