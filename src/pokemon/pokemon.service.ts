import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Pokemon } from './entities/pokemon.entity';

import { CreatePokemonDto } from './dto/create-pokemon.dto';
import { UpdatePokemonDto } from './dto/update-pokemon.dto';
import { PaginationDto } from 'src/common/dto/pagination.dto';

@Injectable()
export class PokemonService {

  // grabar en Base de Datos
  constructor(
    @InjectModel(Pokemon.name)
    private readonly pokemonModel: Model<Pokemon>
  ) { }

  async create(createPokemonDto: CreatePokemonDto) {
    createPokemonDto.name = createPokemonDto.name.toLocaleLowerCase();

    try {
      const pokemon = await this.pokemonModel.create(createPokemonDto);
      return pokemon;

    } catch (err) {
      this.handleExceptions(err);
    }

  }

  // Paginacion - find()
  findAll(paginationDto: PaginationDto) {

    const { limit = 10, offset = 0 } = paginationDto;

    return this.pokemonModel.find()
      .limit(limit)
      .skip(offset)
      .sort({
        no: 1
      })
      .select('-__v');
  }

  async findOne(termDbusqueda: string) {
    let pokemon: Pokemon;

    // ID
    if (!isNaN(+termDbusqueda)) {
      pokemon = await this.pokemonModel.findOne({ no: termDbusqueda });
    }

    // MongoID // !pokemon para que no evalue si ya encontró pokemon por id, tambien se pudiera hacer con una funcion else
    if (!pokemon && isValidObjectId(termDbusqueda)) {
      pokemon = await this.pokemonModel.findById(termDbusqueda);
    }

    // Name
    if (!pokemon) {
      pokemon = await this.pokemonModel.findOne({ name: termDbusqueda.toLowerCase().trim() })
    }

    // NotFound
    if (!pokemon)
      throw new NotFoundException(`Pokemon with id, name or no "${termDbusqueda}" is not found`)

    return pokemon;
    // return `This action returns a #${id} pokemon`;
  }

  async update(termDbusqueda: string, updatePokemonDto: UpdatePokemonDto) {

    const pokemon = await this.findOne(termDbusqueda);

    if (updatePokemonDto.name)
      updatePokemonDto.name = updatePokemonDto.name.toLowerCase();

    try {
      await pokemon.updateOne(updatePokemonDto);

      return { ...pokemon.toJSON(), ...updatePokemonDto };

    } catch (err) {
      this.handleExceptions(err);
    }
  }

  async remove(id: string) {

    // const pokemon = await this.findOne(id);
    // await pokemon.deleteOne();
    // const result = await this.pokemonModel.findByIdAndDelete( id );
    const { deletedCount } = await this.pokemonModel.deleteOne({ _id: id });
    if (deletedCount === 0)
      throw new BadRequestException(`Pokemon with id "${id}" is not found`)

    return;
  }

  private handleExceptions(err: any) {
    if (err.code === 11000) {
      throw new BadRequestException(`This Pokemon already exist in DB ${JSON.stringify(err.keyValue)}`)
    }
    console.log(err);
    throw new InternalServerErrorException(`Can't create Pokemon - Check server logs`);
  }
}
