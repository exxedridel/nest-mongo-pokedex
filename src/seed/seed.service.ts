import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { PokeResponse } from './interfaces/poke-response.interface';
import { CreatePokemonDto } from 'src/pokemon/dto/create-pokemon.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Pokemon } from 'src/pokemon/entities/pokemon.entity';

@Injectable()
export class SeedService {

  private readonly axios: AxiosInstance = axios

  // necessario importar el injectModel correspondiente para insertar en la DB
  constructor(
    @InjectModel(Pokemon.name)
    private readonly pokemonModel: Model<Pokemon>
  ) { }

  async executeSeed() {
    const { data } = await this.axios.get<PokeResponse>('https://pokeapi.co/api/v2/pokemon?limit=10')

    await data.results.forEach(async({ name, url }) => {
      const segments = url.split('/');
      const no: number = +segments[segments.length - 2];


      const createPokemonDto = { name, no }
      // console.log(createPokemonDto)

      const pokemon = await this.pokemonModel.create(createPokemonDto);
    })

    return 'Seed Executed';
  }

}
