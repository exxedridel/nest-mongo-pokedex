import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Pokemon } from 'src/pokemon/entities/pokemon.entity';
import { PokeResponse } from './interfaces/poke-response.interface';
import { AxiosAdapter } from 'src/common/http-adapters/axios.adapter';

@Injectable()
export class SeedService {

  // necessario importar el injectModel correspondiente para insertar en la DB
  constructor(
    @InjectModel(Pokemon.name)
    private readonly pokemonModel: Model<Pokemon>,
    private readonly http: AxiosAdapter,
  ) { }

  async executeSeed() {

    await this.pokemonModel.deleteMany({}); // es como (sql): delete * from pokemons;

    const data = await this.http.get<PokeResponse>('https://pokeapi.co/api/v2/pokemon?limit=650')

    const pokemonToInsert: { name: string, no: number }[] = [];

    await data.results.forEach(({ name, url }) => {

      const segments = url.split('/');
      const no: number = +segments[segments.length - 2];

      // const pokemon = await this.pokemonModel.create({ name, no });
      pokemonToInsert.push({ name, no });
    })

    // crea una sola insercion con todas las entradas, para mejor performance
    await this.pokemonModel.insertMany(pokemonToInsert);
    // es como (sql): insert into pokemons (name, no) del json recibido con todos los datos

    return 'Seed Generated Successfully';
  }

}
